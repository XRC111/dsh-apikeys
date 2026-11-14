/**
 * Persisted account health.
 *
 * Two different kinds of state, with different lifetimes:
 *
 * - **Verification results** are durable. "This key worked at 14:02 and named
 *   octocat" is still useful tomorrow, and re-asking the user to click Verify
 *   because the page reloaded is the kind of small friction that makes a
 *   feature go unused.
 * - **Cooldowns** are ephemeral. They exist to stop a call from hammering a key
 *   the platform just rejected, and a restart is a fine moment to forget them.
 *
 * Health is advisory. It never decides whether a call is allowed — only which
 * credential a rotation pool tries first.
 */
import fs from 'node:fs';
import path from 'node:path';

/** `<platform>-<account>` — the same shape as the credential record id. */
function stateId(platform, account) {
  return `${platform}-${account}`;
}

/**
 * @param options.file - where verification results are persisted; omit for memory only.
 */
export function createHealthStore(options = {}) {
  const file = typeof options.file === 'string' && options.file.length > 0 ? options.file : undefined;
  /** @type {Record<string, {at: string, ok: boolean, status?: number, identity?: string, message?: string}>} */
  let verifications = {};
  /** @type {Map<string, {until: number, failures: number}>} */
  const cooldowns = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (file === undefined) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.verifications === 'object') {
        verifications = parsed.verifications ?? {};
      }
    } catch {
      verifications = {};
    }
  }

  function persist() {
    if (file === undefined) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), verifications }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch {
      // Losing a health record is not worth failing a call over.
    }
  }

  return {
    /** Record the outcome of a verify. */
    recordVerification(platform, account, outcome) {
      load();
      verifications[stateId(platform, account)] = {
        at: new Date().toISOString(),
        ok: outcome.ok === true,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
        ...(outcome.identity === undefined ? {} : { identity: outcome.identity }),
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      };
      persist();
    },

    /** The last verification for one account, if any. */
    verification(platform, account) {
      load();
      return verifications[stateId(platform, account)];
    },

    /** Every verification, keyed by `<platform>-<account>`. */
    all() {
      load();
      return { ...verifications };
    },

    /**
     * Note a rejection and compute the next allowed attempt.
     *
     * Backoff doubles per consecutive failure, capped, so a genuinely dead key
     * stops being retried without being retired forever.
     */
    markFailure(platform, account, options2 = {}) {
      const id = stateId(platform, account);
      const previous = cooldowns.get(id)?.failures ?? 0;
      const failures = previous + 1;
      const baseMs = Number.isFinite(options2.baseMs) ? options2.baseMs : 5000;
      const maxMs = Number.isFinite(options2.maxMs) ? options2.maxMs : 300000;
      const delay = Math.min(maxMs, baseMs * 2 ** (failures - 1));
      cooldowns.set(id, { until: Date.now() + delay, failures });
      return { failures, until: Date.now() + delay, delayMs: delay };
    },

    /** How long until this account may be retried; 0 when it is healthy. */
    cooldownRemaining(platform, account) {
      const entry = cooldowns.get(stateId(platform, account));
      if (entry === undefined) return 0;
      const remaining = entry.until - Date.now();
      if (remaining <= 0) {
        cooldowns.delete(stateId(platform, account));
        return 0;
      }
      return remaining;
    },

    /** Consecutive failures currently recorded, 0 when healthy. */
    failureCount(platform, account) {
      return cooldowns.get(stateId(platform, account))?.failures ?? 0;
    },

    /** A success clears the backoff: the key works again. */
    markSuccess(platform, account) {
      cooldowns.delete(stateId(platform, account));
    },

    /** The live cooldowns, for the settings page. */
    cooldowns() {
      const now = Date.now();
      const output = {};
      for (const [id, entry] of cooldowns) {
        const remaining = entry.until - now;
        if (remaining <= 0) {
          cooldowns.delete(id);
          continue;
        }
        output[id] = { remainingMs: remaining, failures: entry.failures };
      }
      return output;
    },
  };
}
