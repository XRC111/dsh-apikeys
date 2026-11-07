/**
 * Verify the package installed from npm actually works.
 *
 * Runs the published host half against the runtime's own schema validator and
 * drives a tool call, so a packaging mistake (a file left out, a stale build)
 * fails here instead of on a user's machine.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const toolsPath = process.env.DSH_TOOLS_PATH;
if (!toolsPath) {
  console.error('set DSH_TOOLS_PATH to the runtime dsh-tools/lib/index.js');
  process.exit(1);
}
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(toolsPath).href);

const pkgDir = process.env.PKG_DIR;
if (!pkgDir) {
  console.error('set PKG_DIR to the installed package directory');
  process.exit(1);
}

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}`); failures.push(label); }
}

const plugin = await import(pathToFileURL(path.join(pkgDir, 'index.js')).href);
check(typeof plugin.apply === 'function', 'the installed index.js exports apply()');

// The credential store the tools talk to.
const records = new Map();
const credentials = {
  async readRecord(key) { return records.get(String(key)); },
  async listRecords() { return [...records].map(([key, record]) => ({ key, kind: record.kind })); },
  async modifyRecord(key, mutate) {
    const next = await mutate(records.get(String(key)));
    if (next !== undefined) records.set(String(key), next);
    return next;
  },
  async deleteRecord(key) { records.delete(String(key)); },
  async resolve() { return undefined; },
};

const registered = [];
const routes = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) { return name === 'credentials' ? credentials : undefined; },
  inject(_deps, callback) { return callback(ctx); },
  effect(callback) { return callback(); },
  tools: { register(definition) { registered.push(definition); return () => {}; } },
  webServer: { register(route) { routes.push(route); return () => {}; } },
};

plugin.apply(ctx, { defaultPlatform: 'github', defaultAccount: 'default' });

check(registered.length === 3, 'three tools registered from the installed package');
check(registered.map((t) => t.name).join(',') === 'apikey_call,apikey_platforms,apikey_key', 'expected tool names');
check(routes.length === 4, 'four bridge routes registered');

for (const tool of registered) {
  let ok = true;
  try { assertSupportedJsonSchema(tool.output.schema); } catch { ok = false; }
  check(ok, `${tool.name} output schema is valid`);
}

const call = registered.find((t) => t.name === 'apikey_call');
check(validateJsonSchemaValue(call.parameters, { platform: 'github', path: '/user' }).length === 0, 'a minimal call validates');
check(validateJsonSchemaValue(call.parameters, { path: '/user' }).length > 0, 'platform is required');

// Drive one real request through the local platform table, with a stub so the
// check stays offline, and confirm the key reaches the header.
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  return new Response(JSON.stringify({ login: 'installed-check' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

await registered.find((t) => t.name === 'apikey_key')
  .execute({ action: 'set', platform: 'github', value: 'installedKey' }, { signal: new AbortController().signal });
const reply = await call.execute({ platform: 'github', path: '/user' }, { signal: new AbortController().signal });
check(reply.ok === true, 'a call through the installed package succeeds');
check(requests.at(-1).init.headers.authorization === 'Bearer installedKey', 'the stored key is attached');
check(reply.data.login === 'installed-check', 'the JSON body is parsed');

// The locale resources and patch must be present for DSH to show the plugin.
import fs from 'node:fs';
for (const file of ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'client.js']) {
  check(fs.existsSync(path.join(pkgDir, file)), `the package ships ${file}`);
}
const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'locale/en.json'), 'utf8')).meta;
check(typeof meta.title === 'string' && meta.title.length > 0, 'the English locale carries a title');

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('the published package works');
}
