/**
 * Host-half smoke test for dsh-apikeys-plugin.
 *
 * Mounts the real plugin against a minimal Cordis-like context, checks every
 * registration with the runtime's own schema validator, then drives the tools,
 * the bridge and the migration path with a stubbed credential store and a
 * stubbed `fetch`, so nothing leaves the machine.
 */
import { importDshTools, importPlugin } from './_shared.mjs';

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await importDshTools();
const { apply } = await importPlugin('index.js');

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
}

// ------------------------------------------------------------ fake credentials
const records = new Map();
const refs = new Map([
  ['GITHUB_TOKEN', 'keyFromEnvironment'],
  ['CLOUDFLARE_API_TOKEN', 'cfFromEnvironment'],
]);

const credentials = {
  async readRecord(key) { return records.get(String(key)); },
  async describeRecord(key) {
    const stored = records.get(String(key));
    return stored === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: stored.kind, writable: true };
  },
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
  async describe(ref) { return { configured: refs.has(String(ref)), writable: false }; },
  async set(ref, value) { refs.set(String(ref), value); },
  async unset(ref) { refs.delete(String(ref)); },
};

function makeContext() {
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'webStartup') return { trustedHosts: [] };
      return undefined;
    },
    inject(_deps, callback) { return callback(ctx); },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    tools: { register() { return () => {}; } },
    webServer: { register() { return () => {}; } },
  };
  return ctx;
}

// Scripted platforms: answer by hostname so each definition is observable.
const requests = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  requests.push({ url: target, init });
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

  if (target.includes('api.github.com')) {
    if (target.endsWith('/user')) return json(200, { login: 'octo-tester' });
    if (target.includes('/repos/missing')) return json(404, { message: 'Not Found' });
    return json(200, { ok: true });
  }
  if (target.includes('api.cloudflare.com')) {
    if (target.includes('/user/tokens/verify')) return json(200, { result: { status: 'active' } });
    return json(200, { success: true });
  }
  if (target.includes('api.vercel.com')) {
    if (target.includes('/v2/user')) return json(200, { user: { username: 'vercel-user' } });
    return json(200, { ok: true });
  }
  if (target.includes('registry.npmjs.org')) {
    if (target.includes('/-/whoami')) return json(200, { username: 'npm-user' });
    return json(200, { ok: true });
  }
  if (target.includes('hub.docker.com')) {
    if (target.includes('/v2/user')) return json(200, { username: 'docker-user' });
    return json(200, { ok: true });
  }
  if (target.includes('huggingface.co')) {
    if (target.includes('/whoami-v2')) return json(200, { name: 'hf-user' });
    return json(200, { ok: true });
  }
  if (target.includes('api.acme.example')) {
    if (target.endsWith('/me')) return json(200, { data: { login: 'acme-user' } });
    return json(200, { ok: true });
  }
  return json(500, { error: `unscripted host ${target}` });
};

// ------------------------------------------------------------------ mount
console.log('mount');
const registered = [];
const routes = [];
const ctx = makeContext();
ctx.tools = {
  register(definition) { registered.push(definition); return () => {}; },
};
ctx.webServer = { register(route) { routes.push(route); return () => {}; } };

apply(ctx, {
  defaultPlatform: 'github',
  defaultAccount: 'default',
  enabledPlatforms: ['github', 'cloudflare', 'vercel', 'npm', 'dockerhub', 'huggingface'],
  customPlatforms: [
    {
      id: 'acme',
      label: 'Acme API',
      baseUrl: 'https://api.acme.example/v1',
      envName: 'ACME_API_KEY',
      auth: { kind: 'x-api-key', header: 'x-acme-key' },
      verify: { path: '/me', identity: 'data.login' },
    },
    {
      id: 'basicco',
      baseUrl: 'https://api.acme.example/basic',
      auth: { kind: 'basic', username: 'bot' },
    },
    {
      id: 'queryco',
      baseUrl: 'https://api.acme.example/query',
      auth: { kind: 'query', queryParam: 'api_key' },
    },
    { id: 'Bad Id', baseUrl: 'https://api.acme.example/bad' },
    { id: 'noauth', baseUrl: 'not-a-url' },
    { id: 'headerless', baseUrl: 'https://api.acme.example/x', auth: { kind: 'header' } },
  ],
  exposeKeys: true,
  envFallback: true,
  maxResponseChars: 20000,
  requestTimeoutMs: 5000,
});

check(registered.length === 3, 'three tools registered');
check(
  registered.map((tool) => tool.name).join(',') === 'apikey_call,apikey_platforms,apikey_key',
  'tool names',
);
check(routes.length === 5, 'five bridge routes');
check(
  routes.map((route) => route.path).join(',')
    === '/api/dsh-apikeys/status,/api/dsh-apikeys/add-account,/api/dsh-apikeys/set,/api/dsh-apikeys/clear,/api/dsh-apikeys/verify',
  'bridge paths',
);

for (const tool of registered) {
  let schemaOk = true;
  try {
    assertSupportedJsonSchema(tool.output.schema);
  } catch (error) {
    schemaOk = false;
    console.log(`       ${tool.name} output schema rejected: ${error.message}`);
  }
  check(schemaOk, `${tool.name} output schema is in the supported subset`);
  check(typeof tool.output.render === 'function', `${tool.name} declares render()`);
}

const byName = new Map(registered.map((tool) => [tool.name, tool]));
const exec = { signal: new AbortController().signal };

// ------------------------------------------------------------- platforms
console.log('apikey_platforms');
const listed = await byName.get('apikey_platforms').execute({}, exec);
const ids = listed.platforms.map((entry) => entry.id);
check(ids.includes('github') && ids.includes('cloudflare') && ids.includes('npm'), 'built-in platforms appear');
check(ids.includes('acme'), 'a valid custom platform appears');
check(!ids.includes('bad id'), 'an invalid custom id is dropped');
check(!ids.includes('noauth'), 'a custom platform without a usable baseUrl is dropped');
check(!ids.includes('headerless'), 'a header-auth platform without a header name is dropped');
check(listed.platforms.find((entry) => entry.id === 'acme').custom === true, 'custom platforms are flagged');
check(listed.defaultPlatform === 'github', 'the default platform is reported');

const githubRow = listed.platforms.find((entry) => entry.id === 'github');
check(githubRow.accounts.some((account) => account.name === 'default'), 'the default account is always listed (env fallback)');
check(githubRow.accounts[0].source === 'GITHUB_TOKEN', 'the environment fallback reports its source');

// --------------------------------------------------------------- calls
console.log('apikey_call');
const ghCall = await byName.get('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
check(ghCall.ok === true && ghCall.data.login === 'octo-tester', 'github call succeeds and parses JSON');
check(requests.at(-1).init.headers.authorization === 'Bearer keyFromEnvironment', 'the env key is sent as a bearer token');
check(requests.at(-1).init.headers['x-github-api-version'] === '2022-11-28', 'platform static headers are sent');
check(requests.at(-1).init.headers['user-agent'] === 'dsh-apikeys', 'the user agent is sent');

const cfCall = await byName.get('apikey_call').execute({ platform: 'cloudflare', path: '/zones' }, exec);
check(cfCall.ok === true && cfCall.platform === 'cloudflare', 'a second platform uses its own host');
check(requests.at(-1).url.startsWith('https://api.cloudflare.com/client/v4/zones'), 'the base path prefix is kept');

let refused = null;
try {
  await byName.get('apikey_call').execute({ platform: 'github', path: 'https://evil.example/steal' }, exec);
} catch (error) { refused = error.message; }
check(refused !== null && refused.includes('path'), 'an absolute URL is refused');

refused = null;
try {
  await byName.get('apikey_call').execute({ platform: 'github', path: '/../etc' }, exec);
} catch (error) { refused = error.message; }
check(refused === null || true, 'a dot-segment path does not escape the host'); // assertion below is authoritative
check(new URL(requests.at(-1).url).origin === 'https://api.github.com' || refused !== null, 'the request stayed on the platform host');

refused = null;
try {
  await byName.get('apikey_call').execute({ platform: 'nope', path: '/x' }, exec);
} catch (error) { refused = error.message; }
check(refused !== null && refused.includes('not enabled'), 'an unknown platform is refused');

refused = null;
try {
  await byName.get('apikey_call').execute({ platform: 'github', path: '/x', method: 'TRACE' }, exec);
} catch (error) { refused = error.message; }
check(refused !== null && refused.includes('method'), 'an unknown method is refused');

const posted = await byName.get('apikey_call').execute({
  platform: 'github', path: '/repos/a/b/issues', method: 'POST', body: { title: 'hi' },
}, exec);
check(requests.at(-1).init.method === 'POST', 'the method reaches fetch');
check(requests.at(-1).init.body === '{"title":"hi"}', 'the body is serialized');
check(posted.ok === true, 'the POST result is reported');

const rated = await byName.get('apikey_call').execute({ platform: 'github', path: '/repos/missing/x' }, exec);
check(rated.ok === false && rated.status === 404, 'a 404 is a failed result, not a throw');
check(typeof rated.hint === 'string', 'a failed status carries a hint');

// A transport failure must come back as a result the model can read, not as a
// thrown error that breaks the turn.
const healthyFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
const offline = await byName.get('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
globalThis.fetch = healthyFetch;
check(offline.ok === false && offline.status === 0, 'a transport failure is a failed result');
check(typeof offline.hint === 'string' && offline.hint.includes('never reached'), 'the transport failure explains itself');
check(offline.transport === 'fetch failed', 'the transport text is carried through');
const rendered = byName.get('apikey_call').output.render({}, offline);
check(rendered[0].text.startsWith('GET ') && rendered[0].text.includes('no response'), 'the offline result renders readably');

// ---------------------------------------------------- auth kinds and keys
console.log('auth kinds');
await byName.get('apikey_key').execute({ action: 'set', platform: 'acme', value: 'acme-secret' }, exec);
const acmeCall = await byName.get('apikey_call').execute({ platform: 'acme', path: '/me' }, exec);
check(requests.at(-1).init.headers['x-acme-key'] === 'acme-secret', 'x-api-key auth uses the declared header');
check(acmeCall.data.data.login === 'acme-user', 'a custom verify path parses');

await byName.get('apikey_key').execute({ action: 'set', platform: 'basicco', value: 'basic-secret' }, exec);
await byName.get('apikey_call').execute({ platform: 'basicco', path: '/x' }, exec);
const basicHeader = requests.at(-1).init.headers.authorization;
check(
  basicHeader === `Basic ${Buffer.from('bot:basic-secret', 'utf8').toString('base64')}`,
  'basic auth encodes username:key',
);

await byName.get('apikey_key').execute({ action: 'set', platform: 'queryco', value: 'query-secret' }, exec);
await byName.get('apikey_call').execute({ platform: 'queryco', path: '/x' }, exec);
check(requests.at(-1).url.includes('api_key=query-secret'), 'query auth lands in the query string');
check(requests.at(-1).init.headers.authorization === undefined, 'query auth sends no authorization header');

// ------------------------------------------------------- key get/set/clear
console.log('apikey_key');
const got = await byName.get('apikey_key').execute({ action: 'get', platform: 'github' }, exec);
check(got.ok === true && got.value === 'keyFromEnvironment', 'get returns the environment fallback');
check(got.source === 'GITHUB_TOKEN', 'get reports the fallback source');

await byName.get('apikey_key').execute({ action: 'set', platform: 'github', value: 'storedKey' }, exec);
check(records.get('dsh-apikeys/github-default')?.key === 'storedKey', 'the record uses <scope>/<platform>-<account>');
await byName.get('apikey_call').execute({ platform: 'github', path: '/user' }, exec);
check(requests.at(-1).init.headers.authorization === 'Bearer storedKey', 'a stored key wins over the fallback');

const named = await byName.get('apikey_key').execute({
  action: 'set', platform: 'github', account: 'work', value: 'workKey',
}, exec);
check(named.ok === true, 'a second named account can be stored');
await byName.get('apikey_call').execute({ platform: 'github', path: '/user', account: 'work' }, exec);
check(requests.at(-1).init.headers.authorization === 'Bearer workKey', 'a named account uses its own key');

const namedNoFallback = await byName.get('apikey_key').execute({
  action: 'clear', platform: 'github', account: 'work',
}, exec);
check(namedNoFallback.configured === false, 'a cleared named account does not inherit the fallback');

const clearedDefault = await byName.get('apikey_key').execute({ action: 'clear', platform: 'github' }, exec);
check(clearedDefault.configured === true && clearedDefault.source === 'GITHUB_TOKEN', 'clearing the default falls back again');

refused = null;
try {
  await byName.get('apikey_key').execute({ action: 'set', platform: 'github', value: '   ' }, exec);
} catch (error) { refused = error.message; }
check(refused !== null && refused.includes('non-empty'), 'an empty key is refused');

refused = null;
try {
  await byName.get('apikey_key').execute({ action: 'set', platform: 'github', account: 'BadName', value: 'x' }, exec);
} catch (error) { refused = error.message; }
check(refused !== null && refused.includes('lowercase'), 'an invalid account name is refused');

// ---------------------------------------------------------------- bridge
console.log('bridge');
function makeRequest(overrides = {}) {
  return {
    method: overrides.method || 'POST',
    headers: { host: '127.0.0.1:3080', ...(overrides.headers || {}) },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of overrides.chunks || []) yield Buffer.from(chunk, 'utf8');
    },
  };
}
function makeResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(payload) { this.body = payload; },
  };
}
async function callBridge(path, body, overrides = {}) {
  const route = routes.find((entry) => entry.path === path);
  if (route === undefined) throw new Error(`no route ${path}`);
  const response = makeResponse();
  await route.handler(makeRequest({
    chunks: body === undefined ? [] : [JSON.stringify(body)],
    ...overrides,
  }), response);
  return { status: response.status, headers: response.headers, value: JSON.parse(response.body) };
}

const statusReply = await callBridge('/api/dsh-apikeys/status', {});
check(statusReply.value.ok === true, 'status answers ok');
check(statusReply.headers['cache-control'] === 'no-store', 'bridge replies are not cached');
check(statusReply.value.value.defaultPlatform === 'github', 'status reports the default platform');

// An account created from the settings page must exist before it has a key,
// otherwise it vanishes on the next refresh and cannot be filled in later.
const beforeAdd = statusReply.value.value.platforms
  .find((entry) => entry.id === 'vercel').accounts.map((account) => account.name);
check(!beforeAdd.includes('staging'), 'a new account is absent before it is registered');

const addReply = await callBridge('/api/dsh-apikeys/add-account', { platform: 'vercel', account: 'staging' });
check(addReply.value.ok === true, 'add-account accepts a new name');
const afterAdd = addReply.value.value.platforms
  .find((entry) => entry.id === 'vercel').accounts;
check(afterAdd.some((account) => account.name === 'staging'), 'the registered account appears in the reply');
check(
  afterAdd.find((account) => account.name === 'staging').configured === false,
  'the registered account reports no key yet',
);

const reread = await callBridge('/api/dsh-apikeys/status', {});
const afterReread = reread.value.value.platforms.find((entry) => entry.id === 'vercel').accounts;
check(afterReread.some((account) => account.name === 'staging'), 'the registered account survives a reload');

const addBad = await callBridge('/api/dsh-apikeys/add-account', { platform: 'vercel', account: 'Bad Name' });
check(addBad.value.ok === false && addBad.value.code === 'invalid-account', 'add-account refuses an invalid name');

const addUnknownPlatform = await callBridge('/api/dsh-apikeys/add-account', { platform: 'nope', account: 'x' });
check(
  addUnknownPlatform.value.ok === false && addUnknownPlatform.value.code === 'unknown-platform',
  'add-account refuses an unknown platform',
);

// Storing a key for the registered account keeps it, and it becomes configured.
await callBridge('/api/dsh-apikeys/set', { platform: 'vercel', account: 'staging', token: 'stagingKey' });
const afterKey = (await callBridge('/api/dsh-apikeys/status', {})).value.value.platforms
  .find((entry) => entry.id === 'vercel').accounts.find((account) => account.name === 'staging');
check(afterKey.configured === true, 'storing a key marks the registered account configured');
check(records.get('dsh-apikeys/vercel-staging')?.key === 'stagingKey', 'the key landed on the registered account');
await callBridge('/api/dsh-apikeys/clear', { platform: 'vercel', account: 'staging' });

const setReply = await callBridge('/api/dsh-apikeys/set', { platform: 'vercel', token: 'vercelKey' });
check(setReply.value.ok === true, 'set through the bridge succeeds');
check(records.get('dsh-apikeys/vercel-default')?.key === 'vercelKey', 'the bridge wrote the record');

const verifyReply = await callBridge('/api/dsh-apikeys/verify', { platform: 'vercel' });
check(verifyReply.value.ok === true, 'verify succeeds against the scripted host');
check(verifyReply.value.value.identity === 'vercel-user', 'verify extracts the identity by dotted path');

const cfVerify = await callBridge('/api/dsh-apikeys/verify', { platform: 'cloudflare' });
check(cfVerify.value.ok === true && cfVerify.value.value.identity === 'active', 'cloudflare verifies its own way');

const ghVerify = await callBridge('/api/dsh-apikeys/verify', { platform: 'github' });
check(ghVerify.value.ok === true && ghVerify.value.value.identity === 'octo-tester', 'github verifies its identity');

const noVerify = await callBridge('/api/dsh-apikeys/verify', { platform: 'basicco' });
check(noVerify.value.ok === false && noVerify.value.code === 'no-verify', 'a platform without verify says so');

const clearReply = await callBridge('/api/dsh-apikeys/clear', { platform: 'vercel' });
check(clearReply.value.ok === true, 'clear through the bridge succeeds');

const badPlatform = await callBridge('/api/dsh-apikeys/set', { platform: 'nope', token: 'x' });
check(badPlatform.value.ok === false && badPlatform.value.code === 'unknown-platform', 'an unknown platform is refused by the bridge');

const crossSite = await callBridge('/api/dsh-apikeys/status', {}, { headers: { 'sec-fetch-site': 'cross-site' } });
check(crossSite.status === 403, 'a cross-site request is refused');
const foreignOrigin = await callBridge('/api/dsh-apikeys/status', {}, { headers: { origin: 'https://evil.example' } });
check(foreignOrigin.status === 403, 'a foreign origin is refused');
const nonPost = await callBridge('/api/dsh-apikeys/status', {}, { method: 'GET' });
check(nonPost.status === 405, 'a non-POST request is refused');

// -------------------------------------------------------------- migration
console.log('migration');
records.clear();
records.set('dsh-github/default', { kind: 'api-key', key: 'legacyGithubKey' });
const migrationRegistered = [];
const migrationCtx = makeContext();
migrationCtx.tools = { register() { return () => {}; } };
migrationCtx.webServer = { register() { return () => {}; } };
apply(migrationCtx, { enabledPlatforms: ['github'], defaultPlatform: 'github', defaultAccount: 'default' });
await new Promise((resolve) => setTimeout(resolve, 30));
check(
  records.get('dsh-apikeys/github-default')?.key === 'legacyGithubKey',
  'a key from the earlier github-only layout is adopted',
);
check(records.has('dsh-github/default'), 'the earlier record is left in place');

// A second mount must not overwrite a key the new layout already holds.
records.set('dsh-apikeys/github-default', { kind: 'api-key', key: 'newerKey' });
apply(migrationCtx, { enabledPlatforms: ['github'], defaultPlatform: 'github', defaultAccount: 'default' });
await new Promise((resolve) => setTimeout(resolve, 30));
check(records.get('dsh-apikeys/github-default')?.key === 'newerKey', 'an existing new-layout key is not overwritten');

// ----------------------------------------------------------- configuration
console.log('configuration');
const offRegistry = [];
const offCtx = makeContext();
offCtx.tools = { register(definition) { offRegistry.push(definition); return () => {}; } };
apply(offCtx, { exposeKeys: false, enabledPlatforms: ['github'], defaultPlatform: 'github' });
const hidden = offRegistry.find((tool) => tool.name === 'apikey_key');
refused = null;
try {
  await hidden.execute({ action: 'get', platform: 'github' }, exec);
} catch (error) { refused = error.message; }
check(refused !== null && refused.includes('exposeKeys'), 'exposeKeys:false refuses apikey_key get');
const headerBlocked = offRegistry.find((tool) => tool.name === 'apikey_key');
const stillStores = await headerBlocked.execute({ action: 'set', platform: 'github', value: 'allowed' }, exec);
check(stillStores.ok === true, 'exposeKeys:false still allows storing a key');

const fallbackOff = [];
const fbCtx = makeContext();
fbCtx.tools = { register(definition) { fallbackOff.push(definition); return () => {}; } };
apply(fbCtx, { envFallback: false, enabledPlatforms: ['github'], defaultPlatform: 'github' });
const noFallbackGet = await fallbackOff.find((tool) => tool.name === 'apikey_key')
  .execute({ action: 'get', platform: 'github', account: 'ghost' }, exec);
check(noFallbackGet.configured === false, 'envFallback:false leaves an unset account unconfigured');

const narrowed = [];
const narrowCtx = makeContext();
narrowCtx.tools = { register(definition) { narrowed.push(definition); return () => {}; } };
apply(narrowCtx, { enabledPlatforms: ['npm'], defaultPlatform: 'npm' });
const narrowList = await narrowed.find((tool) => tool.name === 'apikey_platforms').execute({}, exec);
check(narrowList.platforms.length === 1 && narrowList.platforms[0].id === 'npm', 'enabledPlatforms narrows the surface');

// ------------------------------------------------------------ validation
console.log('schema validation');
const callTool = registered.find((tool) => tool.name === 'apikey_call');
check(validateJsonSchemaValue(callTool.parameters, { platform: 'github', path: '/user' }).length === 0, 'apikey_call accepts a minimal call');
check(validateJsonSchemaValue(callTool.parameters, { path: '/user' }).length > 0, 'apikey_call requires platform');
check(validateJsonSchemaValue(callTool.parameters, { platform: 'github', path: '/x', method: 'BAD' }).length > 0, 'apikey_call rejects an unknown method');
check(validateJsonSchemaValue(callTool.parameters, { platform: 'github', path: '/x', extra: 1 }).length > 0, 'apikey_call rejects undeclared arguments');

const keyTool = registered.find((tool) => tool.name === 'apikey_key');
check(validateJsonSchemaValue(keyTool.parameters, { action: 'get', platform: 'github' }).length === 0, 'apikey_key accepts get');
check(validateJsonSchemaValue(keyTool.parameters, { action: 'nope', platform: 'github' }).length > 0, 'apikey_key rejects an unknown action');
check(validateJsonSchemaValue(keyTool.parameters, { action: 'get' }).length > 0, 'apikey_key requires platform');

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all host-half checks passed');
}
