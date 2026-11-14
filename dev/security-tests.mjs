/**
 * Security regression tests.
 *
 * These cover the properties the plugin claims, at the level where the claim
 * lives: the vault must not open without the password or with a modified file,
 * the audit chain must expose an edit, and redaction must remove both a known
 * key and a recognisable token shape.
 *
 * Deliberately avoids the harness: these modules are plain Node, so this file
 * runs on a fresh clone with no install and no DSH present.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVault, sealVault, rekeyVault, isVaultEnvelope } from '../lib/vault.js';
import { GENESIS, createAuditLog, hashEntry } from '../lib/audit.js';
import { createRedactor, REDACTED } from '../lib/redact.js';
import { createHealthStore } from '../lib/state.js';
import { createVaultStore } from '../lib/vault-store.js';

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
}

/** A short scrypt cost so the suite stays fast; the code path is identical. */
const FAST_KDF = { N: 1 << 12, r: 8, p: 1 };

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apikeys-test-'));

// ------------------------------------------------------------------ vault
console.log('vault');
{
  const payload = { accounts: { 'github-default': { platform: 'github', account: 'default', key: 'ghp_secret' } } };
  const envelope = sealVault(payload, 'correct horse battery staple', FAST_KDF);
  check(isVaultEnvelope(envelope), 'a sealed vault is a recognised envelope');
  check(envelope.version === 1, 'the envelope records its format version');
  check(typeof envelope.kdf.salt === 'string' && envelope.kdf.salt.length > 0, 'the envelope carries a salt');
  check(!JSON.stringify(envelope).includes('ghp_secret'), 'the plaintext does not appear anywhere in the envelope');

  const reopened = openVault(envelope, 'correct horse battery staple');
  check(reopened.accounts['github-default'].key === 'ghp_secret', 'the right password recovers the payload');

  let wrong = null;
  try { openVault(envelope, 'wrong password'); } catch (error) { wrong = error.message; }
  check(wrong !== null && wrong.includes('password is wrong'), 'a wrong password is refused');

  // Two seals of the same payload must not produce the same bytes.
  const again = sealVault(payload, 'correct horse battery staple', FAST_KDF);
  check(again.dek.data !== envelope.dek.data, 'each seal uses a fresh DEK');
  check(again.payload.iv !== envelope.payload.iv, 'each seal uses a fresh payload IV');

  // Tampering: flip one byte of the ciphertext.
  const tampered = JSON.parse(JSON.stringify(envelope));
  const bytes = Buffer.from(tampered.payload.data, 'base64');
  bytes[0] ^= 0xff;
  tampered.payload.data = bytes.toString('base64');
  let damaged = null;
  try { openVault(tampered, 'correct horse battery staple'); } catch (error) { damaged = error.message; }
  check(damaged !== null && damaged.includes('integrity'), 'a modified body fails its integrity check');

  // Tampering: lower the KDF cost. The header is AAD, so the tag must fail.
  const downgraded = JSON.parse(JSON.stringify(envelope));
  downgraded.kdf.N = 1 << 10;
  let downgrade = null;
  try { openVault(downgraded, 'correct horse battery staple'); } catch (error) { downgrade = error.message; }
  check(
    downgrade !== null && downgrade.includes('tampered'),
    'lowering the KDF cost breaks the authenticated header',
  );

  // Tampering: swap in another vault's DEK block.
  const swapped = JSON.parse(JSON.stringify(envelope));
  swapped.dek = again.dek;
  let swap = null;
  try { openVault(swapped, 'correct horse battery staple'); } catch (error) { swap = error.message; }
  check(swap !== null, 'a swapped DEK block is refused');

  const rekeyed = rekeyVault(envelope, 'correct horse battery staple', 'a different password', FAST_KDF);
  check(
    openVault(rekeyed, 'a different password').accounts['github-default'].key === 'ghp_secret',
    'rekeying keeps the payload',
  );
  let oldStillWorks = true;
  try { openVault(rekeyed, 'correct horse battery staple'); } catch { oldStillWorks = false; }
  check(oldStillWorks === false, 'the old password stops working after a rekey');

  let empty = null;
  try { sealVault(payload, ''); } catch (error) { empty = error.message; }
  check(empty !== null, 'sealing with an empty password is refused');
}

// ------------------------------------------------------------------ audit
console.log('audit');
{
  const file = path.join(workDir, 'audit.jsonl');
  const log = createAuditLog({ file, maxEntries: 100 });
  check(log.size() === 0, 'a new log is empty');

  const first = log.append({ actor: 'tool', action: 'key.set', platform: 'github', account: 'default' });
  check(first.seq === 1 && first.prev === GENESIS, 'the first entry links to GENESIS');
  log.append({ actor: 'tool', action: 'call', platform: 'github', account: 'default', detail: { path: '/user' } });
  log.append({ actor: 'user', action: 'account.remove', platform: 'npm', account: 'work' });

  const verified = log.verify();
  check(verified.ok === true && verified.entries === 3, 'an untouched chain verifies');

  check(!JSON.stringify(log.list()).includes('ghp_'), 'the log never records a key value');

  // Editing an entry breaks its own hash.
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  lines[1].action = 'key.get';
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const edited = createAuditLog({ file }).verify();
  check(edited.ok === false && edited.brokenAt === 2, 'an edited entry is detected at its position');

  // Removing an entry breaks the linkage.
  fs.writeFileSync(file, `${[lines[0], lines[2]].map((line) => JSON.stringify(line)).join('\n')}\n`);
  const removed = createAuditLog({ file }).verify();
  check(removed.ok === false, 'a removed entry breaks the chain');

  // Reordering is caught too.
  fs.writeFileSync(file, `${[lines[1], lines[0], lines[2]].map((line) => JSON.stringify(line)).join('\n')}\n`);
  check(createAuditLog({ file }).verify().ok === false, 'reordering entries breaks the chain');

  // A rebuilt chain from scratch is valid — this proves integrity, not authorship.
  const rebuilt = createAuditLog({ file: path.join(workDir, 'rebuilt.jsonl') });
  rebuilt.append({ actor: 'tool', action: 'key.set', platform: 'github', account: 'default' });
  rebuilt.append({ actor: 'tool', action: 'call', platform: 'github', account: 'default' });
  check(rebuilt.verify().ok === true, 'a chain built by anyone with write access still verifies');
  check(
    hashEntry(GENESIS, { seq: 1, at: 'x', actor: 'a', action: 'b', platform: null, account: null, detail: null })
      === hashEntry(GENESIS, { action: 'b', actor: 'a', account: null, seq: 1, at: 'x', platform: null, detail: null }),
    'the hash ignores property order',
  );
}

// --------------------------------------------------------------- redaction
console.log('redaction');
{
  const redactor = createRedactor({});
  check(redactor.enabled === true, 'redaction is on by default');

  const withLiteral = redactor.redactString('token=ghp_abcdefghijklmnopqrstuvwxyz0123', ['ghp_abcdefghijklmnopqrstuvwxyz0123']);
  check(withLiteral === `token=${REDACTED}`, 'a known key value is replaced');

  const withShape = redactor.redactString('Authorization: npm_abcdefghijklmnopqrstuvwxyz0123456789');
  check(withShape.includes(REDACTED) && !withShape.includes('npm_abc'), 'a recognisable token shape is replaced');

  const jwt = redactor.redactString('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
  check(jwt === REDACTED, 'a JWT is replaced');

  const body = redactor.redactValue(
    { echo: 'your key is ghp_realtokenvalue1234567890', nested: { list: ['sk-abcdefghijklmnopqrstuvwx'] } },
    ['ghp_realtokenvalue1234567890'],
  );
  check(body.echo === `your key is ${REDACTED}`, 'a known key inside a nested body is replaced');
  check(body.nested.list[0] === REDACTED, 'patterns apply inside arrays');

  check(redactor.redactString('nothing to see here') === 'nothing to see here', 'ordinary text is untouched');

  // A short "secret" must not shred the payload.
  check(
    redactor.redactString('the value is abc', ['abc']) === 'the value is abc',
    'a very short literal is ignored',
  );

  const off = createRedactor({ enabled: false });
  check(off.redactString('npm_abcdefghijklmnopqrstuvwxyz0123456789') === 'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'redaction can be turned off');

  // Repeated calls must not skip matches (RegExp lastIndex is stateful).
  const twice = [
    redactor.redactString('npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11'),
    redactor.redactString('npm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22'),
  ];
  check(twice[0] === REDACTED && twice[1] === REDACTED, 'a global pattern does not skip the second call');

  const custom = createRedactor({ patterns: ['ACME-[0-9]{6}'] });
  check(custom.redactString('key ACME-123456 here') === `key ${REDACTED} here`, 'custom patterns are honoured');
}

// ------------------------------------------------------------------ health
console.log('health');
{
  const file = path.join(workDir, 'health.json');
  const health = createHealthStore({ file });

  health.recordVerification('github', 'default', { ok: true, status: 200, identity: 'octocat' });
  check(health.verification('github', 'default').identity === 'octocat', 'a verification is recorded');
  check(createHealthStore({ file }).verification('github', 'default').ok === true, 'verification results survive a reload');

  check(health.cooldownRemaining('github', 'default') === 0, 'a healthy account has no cooldown');
  const first = health.markFailure('github', 'default', { baseMs: 1000 });
  check(first.failures === 1 && first.delayMs === 1000, 'the first failure waits one base interval');
  const second = health.markFailure('github', 'default', { baseMs: 1000 });
  check(second.delayMs === 2000, 'the second failure doubles the wait');
  const third = health.markFailure('github', 'default', { baseMs: 1000 });
  check(third.delayMs === 4000, 'the third failure doubles again');
  check(health.cooldownRemaining('github', 'default') > 0, 'a failed account is cooling down');
  check(health.failureCount('github', 'default') === 3, 'consecutive failures are counted');

  health.markSuccess('github', 'default');
  check(health.cooldownRemaining('github', 'default') === 0, 'a success clears the cooldown');
  check(health.failureCount('github', 'default') === 0, 'a success resets the failure count');

  const capped = createHealthStore();
  let last;
  for (let index = 0; index < 20; index += 1) last = capped.markFailure('x', 'y', { baseMs: 1000, maxMs: 8000 });
  check(last.delayMs === 8000, 'the backoff is capped');
}

// ------------------------------------------------------------- vault store
console.log('vault store');
{
  const file = path.join(workDir, 'vault.json');
  const store = createVaultStore({ file, enabled: true });
  check(store.state === 'locked', 'a fresh store starts locked');
  check(store.get('github', 'default') === undefined, 'a locked store returns no key');

  const unlocked = store.unlock('master password one');
  check(unlocked.ok === true && unlocked.created === true, 'the first unlock creates the vault');
  check(unlocked.created === true, 'the creation is reported');

  store.set('github', 'default', 'ghp_first');
  store.set('npm', 'work', 'npm_second');
  check(store.get('github', 'default') === 'ghp_first', 'a stored key is returned');
  check(store.list().length === 2, 'both accounts are listed');
  check(JSON.stringify(store.list()).includes('ghp_first') === false, 'list() never returns key values');

  // On disk it must be encrypted.
  const onDisk = fs.readFileSync(file, 'utf8');
  check(!onDisk.includes('ghp_first') && !onDisk.includes('npm_second'), 'the vault file holds no plaintext key');

  store.remove('npm', 'work');
  check(store.get('npm', 'work') === undefined, 'a removed key is gone');
  check(store.remove('npm', 'work') === false, 'removing an absent account is a no-op');

  // Reopen from disk.
  const reopened = createVaultStore({ file, enabled: true });
  check(reopened.unlock('master password one').ok === true, 'the right password opens the file again');
  check(reopened.get('github', 'default') === 'ghp_first', 'the key survives a restart');

  const wrongStore = createVaultStore({ file, enabled: true });
  const wrongOpen = wrongStore.unlock('wrong password');
  check(wrongOpen.ok === false && wrongStore.state === 'locked', 'a wrong password leaves the store locked');

  // A missing password is an explicit locked state, not a crash.
  const noPassword = createVaultStore({ file, enabled: true });
  check(noPassword.unlock(undefined).ok === false, 'a missing password is reported, not thrown');
  check(noPassword.state === 'locked', 'a missing password leaves the store locked');

  // Rekey.
  const rekeyed = createVaultStore({ file, enabled: true });
  rekeyed.unlock('master password one');
  rekeyed.rekey('master password two');
  const after = createVaultStore({ file, enabled: true });
  check(after.unlock('master password two').ok === true, 'the new password opens the vault after a rekey');
  check(after.get('github', 'default') === 'ghp_first', 'a rekey preserves every key');

  // Locking drops the plaintext.
  rekeyed.lock();
  check(rekeyed.state === 'locked' && rekeyed.get('github', 'default') === undefined, 'locking drops the plaintext');

  // A disabled vault is inert.
  const disabled = createVaultStore({ file: path.join(workDir, 'never.json'), enabled: false });
  check(disabled.state === 'disabled', 'a disabled vault reports itself disabled');
  check(disabled.get('github', 'default') === undefined, 'a disabled vault returns no key');
}

// A vault file that is not JSON must not crash the plugin.
{
  const broken = path.join(workDir, 'broken.json');
  fs.writeFileSync(broken, 'this is not json');
  const store = createVaultStore({ file: broken, enabled: true });
  const result = store.unlock('anything');
  check(result.ok === false && typeof store.lastError === 'string', 'a corrupt vault file is reported, not thrown');
}

fs.rmSync(workDir, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all security checks passed');
}
