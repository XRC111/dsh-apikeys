/**
 * Schema conformance check for dsh-github-plugin against the runtime's own
 * tool-schema validator and argument validator. This is the check that proves
 * the registered `parameters` and `output.schema` are the raw JSON Schema the
 * registry requires, and that model arguments are validated as intended.
 *
 * Needs an installed DSH; `_shared.mjs` explains how it is located.
 */
import { importDshTools, importPlugin } from './_shared.mjs';

const tools = await importDshTools();
const plugin = await importPlugin('index.js');

const registered = [];
const ctx = {
  logger: { info() {} },
  get(name) {
    if (name !== 'credentials') return undefined;
    return { readRecord: async () => undefined, listRecords: async () => [], resolve: async () => undefined };
  },
  inject(_deps, callback) { callback(ctx); },
  effect(callback) { return callback(); },
  tools: { register(definition) { registered.push(definition); return () => {}; } },
  webServer: { register() { return () => {}; } },
};
plugin.apply(ctx, {});

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}`); failures.push(label); }
}

function assert(label, schema) {
  try {
    tools.assertSupportedJsonSchema(schema);
    return true;
  } catch (error) {
    console.log(`       ${label}: ${error.message.slice(0, 240)}`);
    return false;
  }
}

for (const tool of registered) {
  check(assert(`${tool.name}.parameters`, tool.parameters), `${tool.name}: parameters are raw JSON Schema in the supported subset`);
  check(assert(`${tool.name}.output.schema`, tool.output.schema), `${tool.name}: output schema is in the supported subset`);
  check(tool.parameters.type === 'object', `${tool.name}: parameters are object-rooted`);
  check(tool.parameters.required === undefined || Array.isArray(tool.parameters.required), `${tool.name}: required is absent or an array`);
}

const api = registered.find((tool) => tool.name === 'github_api');
const accounts = registered.find((tool) => tool.name === 'github_accounts');
const key = registered.find((tool) => tool.name === 'github_key');

/** Validate model arguments the way the registry does before execute(). */
function validations(schema, value) {
  return tools.validateJsonSchemaValue(schema, value, '');
}

console.log('argument validation');
check(validations(api.parameters, { path: '/user' }).length === 0, 'github_api accepts {path}');
check(validations(api.parameters, {}).length > 0, 'github_api rejects a missing path');
check(validations(api.parameters, { path: 1 }).length > 0, 'github_api rejects a non-string path');
check(validations(api.parameters, { path: '/x', body: { any: { deep: [1, 2, null] } } }).length === 0, 'github_api accepts an arbitrary JSON body');
check(validations(api.parameters, { path: '/x', query: { a: 'b', n: 1, o: { x: true } } }).length === 0, 'github_api accepts a mixed query object');
check(validations(api.parameters, { path: '/x', method: 'BAD' }).length > 0, 'github_api rejects an unknown method');
check(validations(api.parameters, { path: '/x', extra: true }).length > 0, 'github_api rejects an undeclared argument');
check(validations(api.parameters, { path: '/x', method: 'POST' }).length === 0, 'github_api accepts a declared method');

check(validations(accounts.parameters, {}).length === 0, 'github_accounts takes no arguments');
check(validations(accounts.parameters, { extra: 1 }).length > 0, 'github_accounts rejects arguments');

check(validations(key.parameters, { action: 'get' }).length === 0, 'github_key accepts {action:get}');
check(validations(key.parameters, { action: 'set', value: 'x' }).length === 0, 'github_key accepts set with a value');
check(validations(key.parameters, { action: 'nope' }).length > 0, 'github_key rejects an unknown action');
check(validations(key.parameters, {}).length > 0, 'github_key requires an action');

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('all schema checks passed');
}
