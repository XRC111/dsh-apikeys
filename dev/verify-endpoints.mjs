/**
 * Verify endpoint checks: every built-in platform's `verify` path must exist.
 *
 * A missing path answers 404; a real endpoint that needs credentials answers
 * 401/403/400. A platform whose path 404s would make the page's Verify button
 * lie, so this is a correctness check on the platform table.
 */
import { importPlugin } from './_shared.mjs';

const { apply } = await importPlugin('index.js');

const registered = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'credentials') {
      return {
        async readRecord() { return { kind: 'api-key', key: 'probe-invalid-token' }; },
        async listRecords() { return []; },
        async modifyRecord() { return undefined; },
        async deleteRecord() {},
        async resolve() { return undefined; },
      };
    }
    return undefined;
  },
  inject(_deps, callback) { return callback(ctx); },
  effect(callback) { return callback(); },
  tools: { register(definition) { registered.push(definition); return () => {}; } },
  webServer: { register() { return () => {}; } },
};

apply(ctx, {
  defaultPlatform: 'github',
  defaultAccount: 'default',
  enabledPlatforms: ['github', 'cloudflare', 'vercel', 'npm', 'dockerhub', 'huggingface'],
  customPlatforms: [],
  exposeKeys: true,
  envFallback: false,
  requestTimeoutMs: 25000,
});

const platformsTool = registered.find((tool) => tool.name === 'apikey_platforms');
const listed = await platformsTool.execute({}, { signal: new AbortController().signal });

const failures = [];
for (const platform of listed.platforms) {
  const url = platform.baseUrl;
  console.log(`${platform.id.padEnd(12)} base ${url}`);
}

// Drive each built-in's verify through the tool surface by calling the bridge
// logic indirectly: apikey_call to the verify path with an invalid token.
const callTool = registered.find((tool) => tool.name === 'apikey_call');
const verifyPaths = {
  github: '/user',
  cloudflare: '/user/tokens/verify',
  vercel: '/v2/user',
  npm: '/-/whoami',
  dockerhub: '/user',
  huggingface: '/whoami-v2',
};

console.log('');
for (const [platform, path] of Object.entries(verifyPaths)) {
  const started = Date.now();
  let result;
  try {
    result = await callTool.execute({ platform, path }, { signal: new AbortController().signal });
  } catch (error) {
    console.log(`${platform.padEnd(12)} THREW  ${error.message.slice(0, 90)}`);
    failures.push(`${platform}: threw`);
    continue;
  }
  const elapsed = Date.now() - started;
  const verdict = result.status === 404
    ? 'PATH MISSING'
    : result.status === 0 || result.status >= 500
      ? 'server/network'
      : 'endpoint exists';
  const label = result.status === 404 ? 'FAIL' : 'ok  ';
  if (result.status === 404) failures.push(`${platform}: verify path 404s`);
  console.log(`${label} ${platform.padEnd(12)} ${String(result.status).padEnd(4)} ${verdict.padEnd(16)} ${elapsed}ms`);
  if (typeof result.data === 'string' && result.data.length > 0) {
    console.log(`     ${result.data.replace(/\s+/gu, ' ').slice(0, 100)}`);
  }
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} problem(s):`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('every verify path resolves (none 404)');
}
