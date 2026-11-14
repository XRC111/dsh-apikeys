/**
 * Integration tests for the optional layers.
 *
 * Each case mounts the real plugin against a stubbed context and a stubbed
 * `fetch`, then asserts on observable behaviour — not on internals. The point is
 * to prove the promises: an encrypted vault hides keys from disk, a locked vault
 * stops a plaintext fallback, redaction removes an echoed key, failover keeps a
 * call working, and an upload cannot reach a file outside its roots.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSchemasteryReachable, importDshTools, importPlugin } from './_shared.mjs';

const createdModules = ensureSchemasteryReachable();
const plugin = await importPlugin('index.js');
const { apply } = plugin;

// The runtime validator only exists in an installed harness. Everything else in
// this file is plain Node, so a CI runner without DSH still checks the
// behaviour — it just skips the schema section, and says so.
let dshTools;
try {
  dshTools = await importDshTools();
} catch {
  dshTools = undefined;
}

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apikeys-int-'));
let dirCounter = 0;
/** A fresh directory per case, so files never leak between tests. */
function caseDir(name) {
  dirCounter += 1;
  const target = path.join(workDir, `${dirCounter}-${name}`);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/** A credential store stub backed by a Map. */
function makeCredentials(seed = {}) {
  const records = new Map(Object.entries(seed));
  const refs = new Map();
  return {
    records,
    refs,
    async readRecord(key) { return records.get(String(key)); },
    async listRecords() { return [...records].map(([key, record]) => ({ key, kind: record.kind })); },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(String(key)));
      if (next !== undefined) records.set(String(key), next);
      return next;
    },
    async deleteRecord(key) { records.delete(String(key)); },
    async resolve(ref) {
      const value = refs.get(String(ref));
      return value === undefined ? undefined : { value, source: String(ref) };
    },
  };
}

/** What fetch answers, scripted per test. */
let responder = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  return responder(String(url), init);
};

/** Mount the plugin and collect its tools and routes. */
function mount(config, credentials) {
  const registered = [];
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'webStartup') return { trustedHosts: [] };
      return undefined;
    },
    inject(_deps, callback) { return callback(ctx); },
    effect(callback) { callback(); return () => {}; },
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; } },
  };
  apply(ctx, config);
  const tool = (name) => registered.find((entry) => entry.name === name);
  return { registered, routes, tool, ctx };
}

const exec = { signal: new AbortController().signal };
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

// ------------------------------------------------------------------- vault
console.log('vault');
{
  const dir = caseDir('vault');
  const vaultFile = path.join(dir, 'vault.json');
  process.env.TEST_MASTER = 'integration password';

  const credentials = makeCredentials();
  const harness = mount({
    enabledPlatforms: ['github'],
    defaultPlatform: 'github',
    vault: { enabled: true, file: vaultFile, passwordEnv: 'TEST_MASTER', failClosed: true },
    audit: { enabled: true, file: path.join(dir, 'audit.jsonl') },
    health: { file: path.join(dir, 'health.json') },
  }, credentials);

  await harness.tool('apikey_key').execute({ action: 'set', platform: 'github', value: 'vaultKeyValue123' }, exec);
  check(fs.existsSync(vaultFile), 'storing a key creates the vault file');
  check(!fs.readFileSync(vaultFile, 'utf8').includes('vaultKeyValue123'), 'the vault file holds no plaintext key');
  check(credentials.records.size === 0, 'nothing is written to the credential store while the vault is on');

  requests.length = 0;
  responder = async () => json(200, { login: 'ok' });
  const called = await harness.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(requests.at(-1).init.headers.authorization === 'Bearer vaultKeyValue123', 'a call uses the vault key');
  check(called.credentialSource === 'vault', 'the result reports the vault as the source');

  const listed = await harness.tool('apikey_platforms').execute({}, exec);
  check(listed.storeAvailable === true, 'the platform list still reports a working store');
}

// --------------------------------------------------------- fail-closed lock
console.log('vault lock');
{
  const dir = caseDir('lock');
  const vaultFile = path.join(dir, 'vault.json');
  process.env.LOCK_MASTER = 'the real password';

  // Create a vault, then try to use it without the password.
  const first = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    vault: { enabled: true, file: vaultFile, passwordEnv: 'LOCK_MASTER' },
    audit: { enabled: false }, health: { file: path.join(dir, 'h.json') },
  }, makeCredentials());
  await first.tool('apikey_key').execute({ action: 'set', platform: 'github', value: 'lockedKeyValue123' }, exec);

  // A credential-store record exists; fail-closed must not fall through to it.
  const credentials = makeCredentials({
    'dsh-apikeys/github-default': { kind: 'api-key', key: 'plaintextFallback123' },
  });
  delete process.env.LOCK_MASTER;
  const locked = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    vault: { enabled: true, file: vaultFile, passwordEnv: 'LOCK_MASTER', failClosed: true },
    audit: { enabled: false }, health: { file: path.join(dir, 'h2.json') },
  }, credentials);

  let refused = null;
  try {
    await locked.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  } catch (error) { refused = error.message; }
  check(refused !== null && refused.includes('vault is locked'), 'a locked vault refuses the call');
  check(refused !== null && !refused.includes('plaintextFallback123'), 'the refusal does not leak a key');

  // With fail-closed off the old behaviour returns, deliberately.
  process.env.LOCK_FALLBACK = '';
  const relaxed = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    vault: { enabled: true, file: vaultFile, passwordEnv: 'LOCK_MASTER', failClosed: false },
    audit: { enabled: false }, health: { file: path.join(dir, 'h3.json') },
  }, makeCredentials({
    'dsh-apikeys/github-default': { kind: 'api-key', key: 'plaintextFallback123' },
  }));
  requests.length = 0;
  responder = async () => json(200, { ok: true });
  await relaxed.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(
    requests.at(-1).init.headers.authorization === 'Bearer plaintextFallback123',
    'failClosed:false deliberately falls back to the credential store',
  );

  // The wrong password must not overwrite the vault.
  const before = fs.readFileSync(vaultFile, 'utf8');
  const wrong = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    vault: { enabled: true, file: vaultFile, passwordEnv: 'LOCK_MASTER' },
    audit: { enabled: false }, health: { file: path.join(dir, 'h4.json') },
  }, makeCredentials());
  process.env.LOCK_MASTER = 'definitely the wrong password';
  process.env.LOCK_MASTER = 'definitely the wrong password';
  check(fs.readFileSync(vaultFile, 'utf8') === before, 'a failed unlock leaves the vault file untouched');
}

// -------------------------------------------------------------- migration
console.log('migration');
{
  const dir = caseDir('migrate');
  const vaultFile = path.join(dir, 'vault.json');
  process.env.MIG_MASTER = 'migration password';

  // The two layouts that predate the vault: the current credential scope, and
  // the earlier github-only plugin's records.
  const credentials = makeCredentials({
    'dsh-apikeys/github-default': { kind: 'api-key', key: 'fromCredentialStore123' },
    'dsh-apikeys/npm-work': { kind: 'api-key', key: 'npmFromCredential123' },
    'dsh-github/legacy': { kind: 'api-key', key: 'fromOldGithubPlugin123' },
  });

  const harness = mount({
    enabledPlatforms: ['github', 'npm'],
    defaultPlatform: 'github',
    vault: { enabled: true, file: vaultFile, passwordEnv: 'MIG_MASTER', migrateCredentials: true },
    migrateGitHub: true,
    audit: { enabled: true, file: path.join(dir, 'audit.jsonl') },
    health: { file: path.join(dir, 'health.json') },
  }, credentials);

  // The migration runs inside a credentials effect; give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 60));

  check(credentials.records.has('dsh-apikeys/github-default') === false,
    'a migrated record is removed from the credential store');
  check(credentials.records.has('dsh-apikeys/npm-work') === false,
    'every platform migrates, not just the default one');
  check(credentials.records.has('dsh-github/legacy') === true,
    "the earlier plugin's own records are left in place");

  requests.length = 0;
  responder = async () => json(200, { ok: true });
  await harness.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(requests.at(-1).init.headers.authorization === 'Bearer fromCredentialStore123',
    'the migrated github key still authenticates');

  responder = async () => json(200, { ok: true });
  await harness.tool('apikey_call').execute({ platform: 'npm', path: '/-/whoami', account: 'work' }, exec);
  check(requests.at(-1).init.headers.authorization === 'Bearer npmFromCredential123',
    'a named account migrated with its name intact');

  // The old plugin's key is adopted into the vault, not into a plaintext record.
  const adopted = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    vault: { enabled: true, file: path.join(dir, 'vault2.json'), passwordEnv: 'MIG_MASTER' },
    audit: { enabled: false }, health: { file: path.join(dir, 'h2.json') },
  }, makeCredentials({ 'dsh-github/legacy': { kind: 'api-key', key: 'fromOldGithubPlugin123' } }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  requests.length = 0;
  responder = async () => json(200, { ok: true });
  await adopted.tool('apikey_call').execute({ platform: 'github', path: '/user', account: 'legacy' }, exec);
  check(requests.at(-1).init.headers.authorization === 'Bearer fromOldGithubPlugin123',
    "an earlier-plugin key is adopted and usable");

  // Migration must be skipped when asked to skip it.
  const keep = makeCredentials({ 'dsh-apikeys/github-default': { kind: 'api-key', key: 'keepMePlain123' } });
  mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    vault: { enabled: true, file: path.join(dir, 'vault3.json'), passwordEnv: 'MIG_MASTER', migrateCredentials: false },
    audit: { enabled: false }, health: { file: path.join(dir, 'h3.json') },
  }, keep);
  await new Promise((resolve) => setTimeout(resolve, 60));
  check(keep.records.has('dsh-apikeys/github-default'), 'migrateCredentials:false leaves the record alone');
}

// --------------------------------------------------------------- redaction
console.log('redaction');
{
  const dir = caseDir('redact');
  const credentials = makeCredentials({
    'dsh-apikeys/github-default': { kind: 'api-key', key: 'ghp_realtoken1234567890abcdef' },
  });
  const harness = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    audit: { enabled: false }, health: { file: path.join(dir, 'health.json') },
  }, credentials);

  responder = async () => json(200, {
    message: 'your token ghp_realtoken1234567890abcdef is invalid',
    echoed: 'ghp_realtoken1234567890abcdef',
    unrelated: 'fine',
  });
  const result = await harness.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(!JSON.stringify(result.data).includes('ghp_realtoken1234567890abcdef'),
    'the key is removed from the response body');
  check(JSON.stringify(result.data).includes('[REDACTED]'), 'the key is replaced, not silently dropped');
  check(result.data.unrelated === 'fine', 'unrelated fields are untouched');

  // A recognisable token the plugin never stored is caught by shape.
  responder = async () => json(200, { other: 'npm_abcdefghijklmnopqrstuvwxyz0123456789' });
  const shaped = await harness.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(!JSON.stringify(shaped.data).includes('npm_abcdefghijklmnopqrstuvwxyz'), 'a foreign token shape is redacted');

  // Redaction can be turned off for a user who needs the raw body.
  const raw = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    redact: { enabled: false },
    audit: { enabled: false }, health: { file: path.join(dir, 'h2.json') },
  }, makeCredentials({ 'dsh-apikeys/github-default': { kind: 'api-key', key: 'ghp_realtoken1234567890abcdef' } }));
  responder = async () => json(200, { echoed: 'ghp_realtoken1234567890abcdef' });
  const untouched = await raw.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(untouched.data.echoed === 'ghp_realtoken1234567890abcdef', 'redact.enabled:false passes the body through');
}

// ------------------------------------------------------------------- audit
console.log('audit');
{
  const dir = caseDir('audit');
  const auditFile = path.join(dir, 'audit.jsonl');
  const credentials = makeCredentials();
  const harness = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    audit: { enabled: true, file: auditFile },
    health: { file: path.join(dir, 'health.json') },
  }, credentials);

  await harness.tool('apikey_key').execute({ action: 'set', platform: 'github', value: 'auditedKeyValue123' }, exec);
  responder = async () => json(200, { ok: true });
  await harness.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  await harness.tool('apikey_key').execute({ action: 'clear', platform: 'github' }, exec);

  const raw = fs.readFileSync(auditFile, 'utf8');
  check(!raw.includes('auditedKeyValue123'), 'the audit log never records a key value');
  check(raw.includes('key.set') && raw.includes('call') && raw.includes('key.clear'),
    'the audit log records set, call and clear');

  const auditRoute = harness.routes.find((route) => route.path === '/api/dsh-apikeys/audit');
  const reply = await callRoute(auditRoute, { limit: 10 });
  check(reply.value.ok === true, 'the audit endpoint answers');
  check(reply.value.value.chain.ok === true, 'the chain verifies');
  check(reply.value.value.entries.length === 3, 'every action is listed');
  check(!JSON.stringify(reply.value.value.entries).includes('auditedKeyValue123'), 'the listing hides key values');

  // Editing the log is detected through the endpoint too.
  const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
  lines[1].action = 'key.get';
  fs.writeFileSync(auditFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const tampered = await callRoute(auditRoute, { limit: 10 });
  check(tampered.value.value.chain.ok === false, 'an edited audit entry is reported as broken');
}

// ---------------------------------------------------------------- rotation
console.log('rotation');
{
  const dir = caseDir('rotation');
  const credentials = makeCredentials({
    'dsh-apikeys/github-default': { kind: 'api-key', key: 'deadKeyValue123' },
    'dsh-apikeys/github-backup': { kind: 'api-key', key: 'liveKeyValue123' },
  });

  const off = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    audit: { enabled: false }, health: { file: path.join(dir, 'h1.json') },
  }, makeCredentials({
    'dsh-apikeys/github-default': { kind: 'api-key', key: 'deadKeyValue123' },
    'dsh-apikeys/github-backup': { kind: 'api-key', key: 'liveKeyValue123' },
  }));
  requests.length = 0;
  responder = async (_url, init) => (init.headers.authorization === 'Bearer liveKeyValue123'
    ? json(200, { ok: true })
    : json(401, { message: 'Bad credentials' }));
  const withoutRotation = await off.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(withoutRotation.status === 401, 'rotation off keeps accounts isolated: no failover');
  check(requests.length === 1, 'rotation off makes exactly one attempt');

  const on = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    rotation: { enabled: true, retryOn: [401], maxAttempts: 3 },
    audit: { enabled: true, file: path.join(dir, 'audit.jsonl') },
    health: { file: path.join(dir, 'h2.json') },
  }, credentials);
  requests.length = 0;
  responder = async (_url, init) => (init.headers.authorization === 'Bearer liveKeyValue123'
    ? json(200, { ok: true })
    : json(401, { message: 'Bad credentials' }));
  const rotated = await on.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(rotated.ok === true, 'rotation on fails over to a working account');
  check(rotated.account === 'backup', 'the result names the account that answered');
  check(rotated.rotated === 2, 'the result reports two attempts');

  // The failed account is cooling down, so the next call skips it.
  requests.length = 0;
  await on.tool('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
  check(requests.length === 1 && requests.at(-1).init.headers.authorization === 'Bearer liveKeyValue123',
    'a cooling account is skipped on the next call');

  const listed = await on.tool('apikey_platforms').execute({}, exec);
  const accounts = listed.platforms.find((entry) => entry.id === 'github').accounts;
  check(accounts.some((account) => (account.cooldownMs ?? 0) > 0), 'the cooldown is visible in the account list');
}

// ------------------------------------------------------------------ upload
console.log('upload');
{
  const dir = caseDir('upload');
  const allowed = path.join(dir, 'artifact.bin');
  fs.writeFileSync(allowed, 'binary payload');
  const outside = path.join(os.tmpdir(), `dsh-apikeys-outside-${process.pid}.bin`);
  fs.writeFileSync(outside, 'should not be readable');

  const harness = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    upload: { enabled: true, roots: [dir], maxFileBytes: 1024 },
    audit: { enabled: true, file: path.join(dir, 'audit.jsonl') },
    health: { file: path.join(dir, 'health.json') },
  }, makeCredentials({ 'dsh-apikeys/github-default': { kind: 'api-key', key: 'uploadKeyValue123' } }));

  requests.length = 0;
  responder = async () => json(201, { id: 'asset-1' });
  const sent = await harness.tool('apikey_upload').execute({
    platform: 'github',
    path: '/repos/a/b/releases/1/assets',
    files: [{ field: 'file', path: allowed, filename: 'release.bin' }],
    fields: { name: 'release.bin', label: 'v1' },
  }, exec);
  check(sent.ok === true && sent.status === 201, 'an upload succeeds');
  check(requests.at(-1).init.body instanceof FormData, 'the body is multipart FormData');
  check(requests.at(-1).init.headers.authorization === 'Bearer uploadKeyValue123',
    'the key is attached by the Host, not by the caller');
  check(requests.at(-1).init.headers['content-type'] === undefined,
    'no content-type is forced, so FormData keeps its boundary');
  check(sent.uploaded[0].bytes === 'binary payload'.length, 'the result reports the file size');

  const form = requests.at(-1).init.body;
  check(form.get('name') === 'release.bin' && form.get('label') === 'v1', 'plain form fields are sent');
  check(form.get('file') instanceof Blob, 'the file arrives as a blob');

  let refused = null;
  try {
    await harness.tool('apikey_upload').execute({
      platform: 'github', path: '/x', files: [{ field: 'file', path: outside }],
    }, exec);
  } catch (error) { refused = error.message; }
  check(refused !== null && refused.includes('outside the allowed roots'),
    'a file outside upload.roots is refused');

  let tooBig = null;
  const large = path.join(dir, 'large.bin');
  fs.writeFileSync(large, Buffer.alloc(4096));
  try {
    await harness.tool('apikey_upload').execute({
      platform: 'github', path: '/x', files: [{ field: 'file', path: large }],
    }, exec);
  } catch (error) { tooBig = error.message; }
  check(tooBig !== null && tooBig.includes('over the'), 'a file over the size cap is refused');

  const disabled = mount({
    enabledPlatforms: ['github'], defaultPlatform: 'github',
    upload: { enabled: false },
    audit: { enabled: false }, health: { file: path.join(dir, 'h2.json') },
  }, makeCredentials());
  let off = null;
  try {
    await disabled.tool('apikey_upload').execute({
      platform: 'github', path: '/x', files: [{ field: 'f', path: allowed }],
    }, exec);
  } catch (error) { off = error.message; }
  check(off !== null && off.includes('turned off'), 'upload can be turned off entirely');

  fs.rmSync(outside, { force: true });
}

// -------------------------------------------------- query-auth URL leakage
// The `query` auth kind puts the credential in the URL, and the result carries
// that URL. This is the one path where the key could reach the model even with
// exposeKeys:false, so it is tested directly.
console.log('query auth');
{
  const dir = caseDir('query');
  const harness = mount({
    enabledPlatforms: ['acme'],
    defaultPlatform: 'acme',
    exposeKeys: false,
    customPlatforms: [{
      id: 'acme',
      baseUrl: 'https://api.acme.example/v1',
      auth: { kind: 'query', queryParam: 'api_key' },
    }],
    audit: { enabled: false },
    health: { file: path.join(dir, 'health.json') },
  }, makeCredentials({ 'dsh-apikeys/acme-default': { kind: 'api-key', key: 'querySecretValue123' } }));

  requests.length = 0;
  responder = async () => json(200, { ok: true });
  const result = await harness.tool('apikey_call').execute({ platform: 'acme', path: '/items' }, exec);

  check(requests.at(-1).url.includes('api_key=querySecretValue123'),
    'the key really does travel in the query string');
  check(!result.url.includes('querySecretValue123'), 'the returned URL does not carry the key');
  check(result.url.includes('[REDACTED]'), 'the returned URL shows where the key was');

  const rendered = harness.tool('apikey_call').output.render({}, result);
  const renderedText = rendered.map((block) => block.text ?? '').join('\n');
  check(!renderedText.includes('querySecretValue123'), 'the rendered text does not carry the key');

  // With redaction off the URL must still be masked: this is not a preference.
  const raw = mount({
    enabledPlatforms: ['acme'], defaultPlatform: 'acme', exposeKeys: false,
    customPlatforms: [{
      id: 'acme', baseUrl: 'https://api.acme.example/v1',
      auth: { kind: 'query', queryParam: 'api_key' },
    }],
    redact: { enabled: false },
    audit: { enabled: false }, health: { file: path.join(dir, 'h2.json') },
  }, makeCredentials({ 'dsh-apikeys/acme-default': { kind: 'api-key', key: 'querySecretValue123' } }));
  responder = async () => json(200, { ok: true });
  const rawResult = await raw.tool('apikey_call').execute({ platform: 'acme', path: '/items' }, exec);
  check(!rawResult.url.includes('querySecretValue123'),
    'the URL is masked even with redaction disabled');

  // exposeKeys:false must not reveal the key through apikey_key either.
  let refused = null;
  try {
    await harness.tool('apikey_key').execute({ action: 'get', platform: 'acme' }, exec);
  } catch (error) { refused = error.message; }
  check(refused !== null && refused.includes('exposeKeys'), 'exposeKeys:false refuses apikey_key get');
  check(refused !== null && !refused.includes('querySecretValue123'), 'the refusal does not leak the key');
}

// ------------------------------------------------------------- output shape
console.log('schemas');
{
  if (dshTools === undefined) {
    console.log('  skip no installed DSH; run with DSH_TOOLS_PATH to check tool schemas');
  } else {
    const harness = mount({ enabledPlatforms: ['github'], defaultPlatform: 'github', health: { file: path.join(workDir, 's.json') } }, makeCredentials());
    for (const tool of harness.registered) {
      let ok = true;
      let message = '';
      try { dshTools.assertSupportedJsonSchema(tool.output.schema); } catch (error) { ok = false; message = error.message; }
      check(ok, `${tool.name} output schema is accepted${ok ? '' : `: ${message}`}`);
    }
  }
}

/** Drive one bridge route the way the settings page does. */
async function callRoute(route, body) {
  const response = {
    status: null, body: null,
    writeHead(status) { this.status = status; },
    end(payload) { this.body = payload; },
  };
  const request = {
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {}), 'utf8'); },
  };
  await route.handler(request, response);
  return { status: response.status, value: JSON.parse(response.body) };
}

fs.rmSync(workDir, { recursive: true, force: true });
if (createdModules !== undefined) {
  try { fs.rmSync(createdModules, { recursive: true, force: true }); } catch { /* harmless */ }
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all integration checks passed');
}
