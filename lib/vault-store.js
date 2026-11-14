/**
 * The vault as a key store.
 *
 * Wraps `vault.js` with the questions the plugin actually asks: is the vault
 * on, is it unlocked, and what is the key for this account. The decrypted
 * payload lives only in this object, which the plugin drops on unload — the
 * plaintext never reaches disk.
 *
 * The payload is a flat map so that adding an account is one small write, and
 * so the CLI can read a vault without knowing anything about the harness.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isVaultEnvelope, openVault, rekeyVault, sealVault } from './vault.js';

/** `<platform>-<account>`, matching the credential record id. */
function mapId(platform, account) {
  return `${platform}-${account}`;
}

/**
 * @param options.file - vault file path (required to be useful).
 * @param options.password - master password, already read from its source.
 * @param options.enabled - whether the vault layer is on at all.
 */
export function createVaultStore(options = {}) {
  const file = typeof options.file === 'string' ? options.file : undefined;
  const enabled = options.enabled === true;

  /** 'disabled' | 'locked' | 'unlocked' */
  let state = enabled ? 'locked' : 'disabled';
  let payload = { accounts: {} };
  let password = undefined;
  let lastError = undefined;

  /** Read and parse the envelope, if the file exists. */
  function readEnvelope() {
    if (file === undefined) return undefined;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined; // no vault yet: a fresh install
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`the vault file ${file} is not JSON`);
    }
    if (!isVaultEnvelope(parsed)) {
      throw new Error(`the vault file ${file} is not a vault envelope`);
    }
    return parsed;
  }

  /** Write the current payload back, encrypting with the unlocked password. */
  function persist() {
    if (file === undefined || password === undefined) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const envelope = sealVault(payload, password);
    // Write through a temporary file so a crash cannot leave a half-written
    // vault: the old file stays readable until the new one is complete.
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  return {
    /** Whether the vault layer is configured on. */
    get enabled() { return enabled; },
    /** 'disabled' | 'locked' | 'unlocked' */
    get state() { return state; },
    /** Why the last unlock attempt failed. */
    get lastError() { return lastError; },
    /** Whether a vault file already exists on disk. */
    exists() {
      return file !== undefined && fs.existsSync(file);
    },
    /** The vault file path. */
    get file() { return file; },

    /**
     * Try to unlock with a password.
     * @returns `{ ok, reason? }` — never throws, so startup can stay calm.
     */
    unlock(candidate) {
      if (!enabled) {
        state = 'disabled';
        return { ok: false, reason: 'the vault is not enabled' };
      }
      if (typeof candidate !== 'string' || candidate.length === 0) {
        state = 'locked';
        lastError = 'no master password was provided';
        return { ok: false, reason: lastError };
      }
      let envelope;
      try {
        envelope = readEnvelope();
      } catch (error) {
        state = 'locked';
        lastError = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: lastError };
      }
      if (envelope === undefined) {
        // No vault yet: this password becomes the one that seals it.
        password = candidate;
        payload = { accounts: {} };
        state = 'unlocked';
        lastError = undefined;
        return { ok: true, created: true };
      }
      try {
        const opened = openVault(envelope, candidate);
        payload = opened !== null && typeof opened === 'object' && typeof opened.accounts === 'object'
          ? opened
          : { accounts: {} };
        password = candidate;
        state = 'unlocked';
        lastError = undefined;
        return { ok: true, created: false };
      } catch (error) {
        state = 'locked';
        lastError = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: lastError };
      }
    },

    /** Forget the password and the plaintext. */
    lock() {
      password = undefined;
      payload = { accounts: {} };
      state = enabled ? 'locked' : 'disabled';
    },

    /** The key for one account, or `undefined`. */
    get(platform, account) {
      if (state !== 'unlocked') return undefined;
      const record = payload.accounts[mapId(platform, account)];
      return record !== undefined && typeof record.key === 'string' ? record.key : undefined;
    },

    /** Store or replace one key. Throws when locked. */
    set(platform, account, key) {
      if (state !== 'unlocked') throw new Error('the vault is locked');
      const id = mapId(platform, account);
      const previous = payload.accounts[id];
      const now = new Date().toISOString();
      payload.accounts[id] = {
        platform,
        account,
        key,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      persist();
      return payload.accounts[id];
    },

    /** Remove one key. Removing an absent account is a no-op. */
    remove(platform, account) {
      if (state !== 'unlocked') throw new Error('the vault is locked');
      const id = mapId(platform, account);
      if (payload.accounts[id] === undefined) return false;
      delete payload.accounts[id];
      persist();
      return true;
    },

    /** Every stored account, without key values. */
    list() {
      if (state !== 'unlocked') return [];
      return Object.values(payload.accounts).map((record) => ({
        platform: record.platform,
        account: record.account,
        updatedAt: record.updatedAt,
      }));
    },

    /** Change the master password, re-wrapping only the DEK. */
    rekey(newPassword) {
      if (state !== 'unlocked') throw new Error('the vault is locked');
      const envelope = readEnvelope();
      if (envelope === undefined) {
        password = newPassword;
        persist();
        return;
      }
      // The payload is already in memory and authoritative; re-sealing it with
      // the new password is enough, and avoids a decrypt round trip.
      password = newPassword;
      persist();
      // Prove the result opens before reporting success.
      openVault(readEnvelope(), newPassword);
      return true;
    },

    /** Import one key without touching other accounts (used by migration). */
    adopt(platform, account, key) {
      if (state !== 'unlocked') throw new Error('the vault is locked');
      if (this.get(platform, account) !== undefined) return false;
      this.set(platform, account, key);
      return true;
    },
  };
}

/** Import the rekey helper for callers that need it. */
export { rekeyVault };
