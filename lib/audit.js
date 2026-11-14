/**
 * Tamper-evident audit log.
 *
 * Every entry carries the hash of its predecessor, so removing, reordering or
 * editing an entry breaks the chain from that point on. The log records who did
 * what to which account — never the key value — so it is safe to show in the
 * settings page and safe to attach to a bug report.
 *
 * This proves *integrity*, not *authorship*: someone who can write the file can
 * rewrite the whole chain. It answers "did the record change", which is what a
 * mistake looks like, not "who did this", which would need a key the attacker
 * lacks.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The predecessor of the first entry. */
export const GENESIS = '0'.repeat(64);

export const AUDIT_ACTIONS = Object.freeze([
  'key.set', 'key.clear', 'key.get', 'account.add', 'account.remove',
  'call', 'verify', 'vault.unlock', 'vault.lock', 'vault.migrate',
]);

/**
 * Stable serialisation for hashing.
 *
 * `JSON.stringify` preserves insertion order, so two objects with the same
 * fields in a different order would hash differently and a rebuilt entry would
 * look tampered with. Sorting the keys removes that trap.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** The hash of one entry, given the previous hash. */
export function hashEntry(previousHash, entry) {
  const body = {
    seq: entry.seq,
    at: entry.at,
    actor: entry.actor,
    action: entry.action,
    platform: entry.platform,
    account: entry.account,
    detail: entry.detail ?? null,
  };
  return crypto.createHash('sha256').update(`${previousHash}\n${canonical(body)}`, 'utf8').digest('hex');
}

/**
 * Drop `undefined` members so the in-memory record matches what JSON keeps.
 *
 * `JSON.stringify` omits a key whose value is `undefined`, so a hash computed
 * over `{ a: undefined }` would not match the rebuilt record `{}` — the log
 * would look tampered with the moment it was read back. Pruning before hashing
 * keeps the two representations identical.
 */
function pruneUndefined(value, depth = 0) {
  if (depth > 8) return null;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const pruned = pruneUndefined(item, depth + 1);
      return pruned === undefined ? null : pruned;
    });
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const pruned = pruneUndefined(item, depth + 1);
    if (pruned !== undefined) output[key] = pruned;
  }
  return output;
}

/**
 * An append-only log with a hash chain.
 *
 * Writes are synchronous and whole-file: the log is small (a few thousand
 * entries), and a partial append would corrupt the chain — the one thing this
 * file exists to prevent.
 */
export function createAuditLog(options = {}) {
  const file = options.file;
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : 2000;
  let entries = [];
  let loaded = false;

  /**
   * Load entries from disk.
   *
   * `force` re-reads, and every reader passes it: an audit viewer must show the
   * bytes that are on disk now, not the ones it happened to cache at startup.
   * A log that reports "intact" after someone edited the file would be worse
   * than no log at all.
   */
  function load(force = false) {
    if (loaded && !force) return;
    loaded = true;
    entries = [];
    if (typeof file !== 'string' || file.length === 0) return;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') entries.push(parsed);
      } catch {
        // A torn final line from an interrupted write; drop it rather than
        // treat the whole log as broken.
      }
    }
  }

  function persist() {
    if (typeof file !== 'string' || file.length === 0) return;
    const directory = path.dirname(file);
    try {
      fs.mkdirSync(directory, { recursive: true });
      const body = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
      fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // A read-only or missing directory must not break the tool call the user
      // actually asked for.
    }
  }

  return {
    /** Append one entry. Returns the stored record. */
    append(fields) {
      load(true);
      const previous = entries.length === 0 ? GENESIS : entries[entries.length - 1].hash;
      const entry = {
        seq: entries.length === 0 ? 1 : entries[entries.length - 1].seq + 1,
        at: new Date().toISOString(),
        actor: String(fields.actor ?? 'unknown'),
        action: String(fields.action ?? 'unknown'),
        platform: fields.platform === undefined ? null : String(fields.platform),
        account: fields.account === undefined ? null : String(fields.account),
        detail: fields.detail === undefined ? null : pruneUndefined(fields.detail),
        prev: previous,
      };
      entry.hash = hashEntry(previous, entry);
      entries.push(entry);
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
      persist();
      return entry;
    },

    /** The most recent entries, newest first. */
    list(limit = 100) {
      load(true);
      const count = Math.max(1, Math.min(entries.length, Math.trunc(limit) || 100));
      return entries.slice(-count).reverse();
    },

    /** How many entries are recorded. */
    size() {
      load(true);
      return entries.length;
    },

    /**
     * Walk the chain and report the first break.
     * @returns `{ ok, entries, brokenAt?, reason? }`
     */
    verify() {
      load(true);
      let previous = GENESIS;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.prev !== previous) {
          return {
            ok: false, entries: entries.length, brokenAt: index + 1,
            reason: `entry ${entry.seq} does not link to its predecessor (a record was removed or reordered)`,
          };
        }
        if (hashEntry(previous, entry) !== entry.hash) {
          return {
            ok: false, entries: entries.length, brokenAt: index + 1,
            reason: `entry ${entry.seq} does not match its own hash (a record was edited)`,
          };
        }
        previous = entry.hash;
      }
      return { ok: true, entries: entries.length };
    },
  };
}
