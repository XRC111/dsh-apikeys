/**
 * Host-half smoke test for dsh-github-plugin.
 *
 * It loads the real plugin module, mounts `apply()` against a minimal Cordis-like
 * context, and checks every registration against the runtime's own tool-schema
 * validator. It also drives the three tools and the bridge handlers with a
 * stubbed `fetch`, so no network call leaves the machine.
 *
 * Needs an installed DSH; `_shared.mjs` explains how it is located.
 */
import { importDshTools, importPlugin } from './_shared.mjs';

const { assertSupportedJsonSchema } = await importDshTools();
const { apply } = await importPlugin('index.js');

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
}

// ---------------------------------------------------------------- fake context
const registered = [];
const routes = [];
const records = new Map();
const refs = new Map([['GITHUB_TOKEN', 'tokenFromEnvironment']]);

const credentials = {
  async readRecord(key) {
    return records.get(String(key));
  },
  async describeRecord(key) {
    const stored = records.get(String(key));
    return stored === undefined ? { configured: false, writable: true } : { configured: true, kind: stored.kind, writable: true };
  },
  async listRecords() {
    return [...records].map(([key, record]) => ({ key, kind: record.kind }));
  },
  async modifyRecord(key, mutate) {
    const next = await mutate(records.get(String(key)));
    if (next !== undefined) records.set(String(key), next);
    return next;
  },
  async deleteRecord(key) {
    records.delete(String(key));
  },
  async resolve(ref) {
    const value = refs.get(String(ref));
    return value === undefined ? undefined : { value, source: String(ref) };
  },
  async describe(ref) {
    return { configured: refs.has(String(ref)), writable: false };
  },
  async set(ref, value) {
    refs.set(String(ref), value);
  },
  async unset(ref) {
    refs.delete(String(ref));
  },
};

function makeContext() {
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'webStartup') return { trustedHosts: [] };
      return undefined;
    },
    inject(dependencies, callback) {
      const scoped = makeContext();
      return callback(scoped);
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on() {
      return () => {};
    },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  return ctx;
}

// A scripted GitHub: the stub answers by URL so tool behaviour is observable.
let lastRequest = null;
globalThis.fetch = async (url, init) => {
  lastRequest = { url: String(url), init };
  const target = String(url);
  if (target.includes('/user')) {
    return new Response(JSON.stringify({ login: 'octo-tester', name: 'Octo Tester' }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4998',
        'x-ratelimit-reset': '1800000000',
        link: '<https://api.github.com/user?page=2>; rel="next", <https://api.github.com/user?page=9>; rel="last"',
      },
    });
  }
  if (target.includes('/repos/missing/missing')) {
    return new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (target.endsWith('/rate_limit')) {
    return new Response(JSON.stringify({ resources: { core: { remaining: 4998 } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

// ---------------------------------------------------------------------- mount
console.log('mount');
apply(makeContext(), {
  baseUrl: 'https://api.github.com/',
  defaultAccount: 'default',
  exposeKeys: true,
  envFallback: true,
  envName: 'GITHUB_TOKEN',
  maxResponseChars: 20000,
  requestTimeoutMs: 5000,
  apiVersion: '2022-11-28',
  userAgent: 'dsh-github-smoke',
});

check(registered.length === 3, 'three tools registered');
check(registered.map((tool) => tool.name).join(',') === 'github_api,github_accounts,github_key', 'tool names');
check(routes.length === 4, 'four bridge routes');

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
  check(tool.parameters !== null && typeof tool.parameters === 'object', `${tool.name} declares parameters`);
  let rendered;
  try {
    rendered = tool.output.render({}, {
      ok: true, status: 200, method: 'GET', url: 'https://api.github.com/user',
      account: 'default', credentialSource: 'stored', truncated: false, data: { hello: 'world' },
      accounts: [], defaultAccount: 'default', envFallback: true, envName: 'GITHUB_TOKEN',
      baseUrl: 'https://api.github.com', storeAvailable: true,
      action: 'get', configured: true, source: 'stored', value: 'token',
    });
  } catch {
    rendered = undefined;
  }
  check(Array.isArray(rendered), `${tool.name} renders a sample value`);
}

const byName = new Map(registered.map((tool) => [tool.name, tool]));
const exec = { signal: new AbortController().signal };

// ------------------------------------------------------------------- accounts
console.log('github_accounts');
const unconfigured = await byName.get('github_accounts').execute({}, exec);
check(unconfigured.accounts.length === 1, 'one account before storing anything');
check(unconfigured.accounts[0].name === 'default', 'the configured default account is listed');
check(unconfigured.accounts[0].configured === true, 'the GITHUB_TOKEN fallback counts as configured');
check(unconfigured.accounts[0].source === 'GITHUB_TOKEN', 'the fallback reports its source');
check(unconfigured.storeAvailable === true, 'the credentials service is reported available');

// ------------------------------------------------------------------ github_api
console.log('github_api');
const user = await byName.get('github_api').execute({ path: '/user' }, exec);
check(user.ok === true && user.status === 200, 'GET /user succeeds');
check(user.data.login === 'octo-tester', 'the JSON body is parsed');
check(user.rateLimit && user.rateLimit.remaining === 4998, 'rate-limit headers are reported');
check(user.pagination && user.pagination.next === 2 && user.pagination.last === 9, 'Link pages are parsed');
check(lastRequest.init.headers.authorization === 'Bearer tokenFromEnvironment', 'the environment token is sent');
check(lastRequest.init.headers['x-github-api-version'] === '2022-11-28', 'the API version header is sent');

const withQuery = await byName.get('github_api').execute({
  path: '/search/issues',
  query: { q: 'is:open repo:a/b', per_page: 5, filter: { nested: true } },
}, exec);
check(decodeURIComponent(lastRequest.url).replace(/\+/gu, ' ').includes('q=is:open repo:a/b'), 'query parameters are encoded into the URL');
check(decodeURIComponent(lastRequest.url).includes('{"nested":true}'), 'object query values are JSON-encoded');

const posted = await byName.get('github_api').execute({
  path: '/repos/a/b/issues', method: 'POST', body: { title: 'hello' },
}, exec);
check(lastRequest.init.method === 'POST', 'the method reaches fetch');
check(lastRequest.init.body === '{"title":"hello"}', 'the body is serialized');
check(lastRequest.init.headers['content-type'] === 'application/json', 'the body sets a content type');

const notFound = await byName.get('github_api').execute({ path: '/repos/missing/missing' }, exec);
check(notFound.ok === false && notFound.status === 404, 'a 404 is reported as a failed result, not a throw');
check(typeof notFound.hint === 'string' && notFound.hint.length > 0, 'a failed status carries a hint');

let refused = null;
try {
  await byName.get('github_api').execute({ path: 'https://evil.example.com/steal' }, exec);
} catch (error) {
  refused = error.message;
}
check(refused !== null && refused.includes('path'), 'an absolute URL is refused');

refused = null;
try {
  await byName.get('github_api').execute({ path: '/user', method: 'TRACE' }, exec);
} catch (error) {
  refused = error.message;
}
check(refused !== null && refused.includes('method'), 'an unknown method is refused');

refused = null;
try {
  await byName.get('github_api').execute({ path: '/user', account: 'Bad/../Name' }, exec);
} catch (error) {
  refused = error.message;
}
check(refused !== null && refused.includes('account'), 'an invalid account name is refused');

// ------------------------------------------------------------- key: get/set
console.log('github_key');
const initial = await byName.get('github_key').execute({ action: 'get' }, exec);
check(initial.ok === true && initial.value === 'tokenFromEnvironment', 'get returns the fallback token');
check(initial.source === 'GITHUB_TOKEN', 'get reports the fallback source');

const stored = await byName.get('github_key').execute({ action: 'set', value: 'tokenStoredForTests' }, exec);
check(stored.ok === true && stored.source === 'stored', 'set stores a token');
check(records.get('dsh-github/default')?.key === 'tokenStoredForTests', 'the record lives under dsh-github/default');

const afterSet = await byName.get('github_api').execute({ path: '/user' }, exec);
check(lastRequest.init.headers.authorization === 'Bearer tokenStoredForTests', 'a stored token wins over the fallback');

const named = await byName.get('github_key').execute({ action: 'set', account: 'work', value: 'tokenForWorkAccount' }, exec);
check(named.ok === true, 'a second named account can be stored');
const accounts = await byName.get('github_accounts').execute({}, exec);
check(accounts.accounts.map((entry) => entry.name).join(',') === 'default,work', 'both accounts are listed');

const workFallback = await byName.get('github_api').execute({ path: '/user', account: 'work' }, exec);
check(lastRequest.init.headers.authorization === 'Bearer tokenForWorkAccount', 'a named account uses its own token');

const cleared = await byName.get('github_key').execute({ action: 'clear' }, exec);
check(cleared.ok === true && cleared.source === 'GITHUB_TOKEN', 'clear falls back to the environment reference');
check(records.has('dsh-github/default') === false, 'the stored record is gone');

const missing = await byName.get('github_key').execute({ action: 'clear', account: 'work' }, exec);
check(missing.configured === false && missing.source === 'unset', 'a named account does not inherit the fallback');

// --------------------------------------------------------------- the bridge
console.log('bridge');
function makeRequest(overrides) {
  const request = {
    method: overrides.method || 'POST',
    headers: { host: '127.0.0.1:3080', ...(overrides.headers || {}) },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of overrides.chunks || []) yield Buffer.from(chunk, 'utf8');
    },
  };
  return request;
}
function makeResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload;
    },
  };
}
async function callBridge(path, body, overrides = {}) {
  const route = routes.find((entry) => entry.path === path);
  if (route === undefined) throw new Error(`no route ${path}`);
  const response = makeResponse();
  await route.handler(
    makeRequest({ chunks: body === undefined ? [] : [JSON.stringify(body)], ...overrides }),
    response,
  );
  return { route: route.path, status: response.status, headers: response.headers, value: JSON.parse(response.body) };
}

const paths = routes.map((route) => route.path).join(',');
check(paths === '/api/dsh-github/status,/api/dsh-github/set,/api/dsh-github/clear,/api/dsh-github/verify', 'bridge paths');

const status = await callBridge('/api/dsh-github/status', {});
check(status.status === 200 && status.value.ok === true, 'status answers ok');
check(status.value.value.defaultAccount === 'default', 'status reports the default account');
check(status.value.value.exposeKeys === true, 'status reports exposeKeys');
check(status.headers['cache-control'] === 'no-store', 'responses are not cached');

const setReply = await callBridge('/api/dsh-github/set', { account: 'default', token: 'tokenFromBridge' });
check(setReply.value.ok === true, 'set through the bridge succeeds');
check(records.get('dsh-github/default')?.key === 'tokenFromBridge', 'the bridge wrote the record');

const verify = await callBridge('/api/dsh-github/verify', { account: 'default' });
check(verify.value.ok === true && verify.value.value.login === 'octo-tester', 'verify reports the GitHub login');

const clearReply = await callBridge('/api/dsh-github/clear', { account: 'default' });
check(clearReply.value.ok === true, 'clear through the bridge succeeds');

const badAccount = await callBridge('/api/dsh-github/set', { account: 'Not Valid', token: 'x' });
check(badAccount.value.ok === false && badAccount.value.code === 'invalid-account', 'an invalid account is refused by the bridge');

const emptyToken = await callBridge('/api/dsh-github/set', { account: 'default', token: '  ' });
check(emptyToken.value.ok === false && emptyToken.value.code === 'empty-token', 'an empty token is refused by the bridge');

const crossSite = await callBridge('/api/dsh-github/status', {}, { headers: { 'sec-fetch-site': 'cross-site' } });
check(crossSite.status === 403, 'a cross-site request is refused');

const foreignOrigin = await callBridge('/api/dsh-github/status', {}, { headers: { origin: 'https://evil.example.com' } });
check(foreignOrigin.status === 403, 'a foreign origin is refused');

const getMethodRoute = await (async () => {
  const route = routes.find((entry) => entry.path === '/api/dsh-github/status');
  const response = makeResponse();
  await route.handler(makeRequest({ method: 'GET' }), response);
  return response.status;
})();
check(getMethodRoute === 405, 'a non-POST request is refused');

// ------------------------------------------------------------- config errors
console.log('configuration');
registered.length = 0;
routes.length = 0;
apply(makeContext(), {});
check(registered.length === 3, 'the defaults mount with no config');
const defaults = await byName.get('github_accounts').execute({}, exec);
check(defaults.baseUrl === 'https://api.github.com', 'the default base URL');
check(defaults.envName === 'GITHUB_TOKEN', 'the default environment reference');

registered.length = 0;
routes.length = 0;
apply(makeContext(), { exposeKeys: false });
const hidden = registered.find((tool) => tool.name === 'github_key');
let blocked = null;
try {
  await hidden.execute({ action: 'get' }, exec);
} catch (error) {
  blocked = error.message;
}
check(blocked !== null && blocked.includes('exposeKeys'), 'exposeKeys:false refuses github_key get');

const hiddenSet = await hidden.execute({ action: 'set', account: 'work', value: 'tokenWorkStillAllowed' }, exec);
check(hiddenSet.ok === true, 'exposeKeys:false still allows storing a token');

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all host-half checks passed');
}
