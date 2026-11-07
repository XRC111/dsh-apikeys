/**
 * Client-half smoke test for dsh-apikeys-plugin.
 *
 * Materializes the browser bundle through the real `__ModuleLoader__` contract,
 * mounts `apply()` against a fake Client context, and renders both slot entries
 * the way the shell would: a hook store persists across renders, effects run
 * after a commit, and a throwing component fails here rather than blanking a
 * seat in the browser.
 */
import { importPlugin } from './_shared.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginFile } from './_shared.mjs';

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
}

// ------------------------------------------------------------ fake React
let instance = { hooks: [], cursor: 0, effects: [], ranEffects: new Set() };
function createInstance() {
  return { hooks: [], cursor: 0, effects: [], ranEffects: new Set() };
}

const React = {
  createElement(type, props, ...children) {
    const combined = { ...(props || {}), children: children.length === 0 ? undefined : children };
    if (typeof type === 'function') return type(combined);
    return { type, props: combined };
  },
  useState(initial) {
    const index = instance.cursor++;
    if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [
      instance.hooks[index],
      (next) => { instance.hooks[index] = typeof next === 'function' ? next(instance.hooks[index]) : next; },
    ];
  },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useEffect(effect) {
    const index = instance.cursor++;
    instance.effects.push({ index, effect });
  },
};

async function render(component, props) {
  instance.cursor = 0;
  instance.effects = [];
  const tree = component(props);
  for (const entry of instance.effects) {
    if (instance.ranEffects.has(entry.index)) continue;
    instance.ranEffects.add(entry.index);
    const cleanup = entry.effect();
    if (typeof cleanup === 'function') cleanup();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return tree;
}
function renderNow(component, props) {
  instance.cursor = 0;
  return component(props);
}
async function renderTwice(component, props) {
  await render(component, props);
  return render(component, props);
}

// --------------------------------------------------------- fake DOM + fetch
const styles = [];
globalThis.document = {
  head: {
    appendChild(node) { node.parentNode = document.head; styles.push(node); },
    removeChild(node) {
      const index = styles.indexOf(node);
      if (index >= 0) styles.splice(index, 1);
      node.parentNode = null;
    },
  },
  createElement() { return { dataset: {}, textContent: '', parentNode: null }; },
};

const calls = [];
const healthyReply = {
  ok: true,
  value: {
    defaultPlatform: 'github',
    defaultAccount: 'default',
    envFallback: true,
    exposeKeys: true,
    storeAvailable: true,
    platforms: [
      {
        id: 'github', label: 'GitHub', baseUrl: 'https://api.github.com', custom: false,
        docs: 'https://github.com/settings/tokens', hint: 'Classic token: repo scope.', note: 'Token stays on the host.',
        envName: 'GITHUB_TOKEN',
        accounts: [{ name: 'default', configured: true, source: 'stored', isDefault: true }],
      },
      {
        id: 'cloudflare', label: 'Cloudflare', baseUrl: 'https://api.cloudflare.com/client/v4', custom: false,
        docs: 'https://dash.cloudflare.com/profile/api-tokens', hint: 'Use an API Token.', note: 'Not the Global key.',
        envName: 'CLOUDFLARE_API_TOKEN',
        accounts: [{ name: 'default', configured: false, source: 'unset', isDefault: true }],
      },
      {
        id: 'acme', label: 'Acme API', baseUrl: 'https://api.acme.example/v1', custom: true,
        docs: undefined, hint: undefined, note: undefined, envName: undefined,
        accounts: [{ name: 'default', configured: false, source: 'unset', isDefault: true }],
      },
    ],
  },
};
let reply = healthyReply;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init.body, headers: init.headers });
  return { ok: true, status: 200, async json() { return reply; } };
};

// --------------------------------------------------- materialize the bundle
let registration;
globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry; } } };
await importPlugin('client.js');
check(registration !== undefined, 'the bundle registers one factory');
check(registration.id === 'dsh-apikeys-plugin', 'the factory id is the package name');

const exportsObject = registration.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected module request: ${name}`);
});
check(exportsObject && typeof exportsObject.apply === 'function', 'the factory returns apply()');
check(Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'), 'the client half injects slots');

// ---------------------------------------------------------------- mount
let registered = [];
let injected = [];
const effects = [];
let localeId = 'zh';
const fakeCtx = {
  get(name) {
    if (name === 'locale') return { getLocale: () => ({ active: localeId }) };
    return undefined;
  },
  effect(callback, label) {
    const dispose = callback();
    effects.push({ label, dispose });
    return dispose;
  },
  slots: {
    inject(key, callback) {
      injected.push(key);
      const dispose = callback();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
};

exportsObject.apply(fakeCtx);
check(injected.includes('plugins.row.config'), 'injects into plugins.row.config');
check(injected.includes('settings.section'), 'injects into settings.section');
check(registered.length === 2, 'two slot entries registered');
check(styles.length === 1 && styles[0].dataset.plugin === 'dsh-apikeys', 'the stylesheet is inserted once');

const rowEntry = registered.find((entry) => entry.options.name === 'plugins.row.config');
const sectionEntry = registered.find((entry) => entry.options.name === 'settings.section');
check(rowEntry.options.key === 'dsh-apikeys-plugin#apikeys', 'the row key is <package>#<patch row id>');
check(sectionEntry.options.id === 'apikeys', 'the settings section uses its own id');
check(sectionEntry.options.label() === 'API Keys', 'the section label resolves');

function flatten(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).join(' ');
  if (typeof node === 'object' && node.props && node.props.children !== undefined) {
    const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
    return children.map(flatten).join(' ');
  }
  return '';
}

// ------------------------------------------------------------ summary line
instance = createInstance();
const summary = flatten(rowEntry.component({ view: 'summary' }));
check(summary.includes('apikey_call'), 'the summary names the tools');

// ------------------------------------------------------------- loaded page
instance = createInstance();
let page = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  page = flatten(renderNow(sectionEntry.component, {}));
} catch (error) { page = `THREW: ${error.message}`; }
check(!page.startsWith('THREW'), `the page renders without throwing (${page.slice(0, 42)}…)`);
check(page.includes('API Keys'), 'the page carries the section title');
check(page.includes('GitHub') && page.includes('Cloudflare') && page.includes('Acme API'), 'every platform is offered');
check(page.includes('GitHub'), 'the default platform is selected');
check(page.includes('已配置'), 'the configured state is shown');
check(page.includes('获取 Key'), 'the docs link is rendered');
check(page.includes('Classic token: repo scope.'), 'the platform hint is rendered');
check(page.includes('Token stays on the host.'), 'the platform note is rendered');
check(calls.length > 0 && calls[0].url === '/api/dsh-apikeys/status', 'the page asks the bridge for status');
check(calls[0].headers['content-type'] === 'application/json', 'the bridge call is JSON');

// A custom platform carries no docs link, so switching must not crash.
instance = createInstance();
let switched = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  switched = flatten(renderNow(sectionEntry.component, {}));
} catch (error) { switched = `THREW: ${error.message}`; }
check(!switched.startsWith('THREW'), 'a custom platform renders');

// -------------------------------------------------------- unreachable host
reply = { ok: false, code: 'network', message: 'boom' };
instance = createInstance();
let unreachable = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  unreachable = flatten(renderNow(sectionEntry.component, {}));
} catch (error) { unreachable = `THREW: ${error.message}`; }
check(!unreachable.startsWith('THREW'), 'a failed bridge call renders a message instead of crashing');
check(unreachable.includes('无法访问'), 'the failure message is localized');

// ------------------------------------------------------------ empty state
reply = {
  ok: true,
  value: { defaultPlatform: 'github', defaultAccount: 'default', envFallback: true, exposeKeys: true, storeAvailable: true, platforms: [] },
};
instance = createInstance();
let empty = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  empty = flatten(renderNow(sectionEntry.component, {}));
} catch (error) { empty = `THREW: ${error.message}`; }
check(!empty.startsWith('THREW'), 'an empty platform list renders');
check(empty.includes('没有启用任何平台'), 'the empty state explains what to configure');

// --------------------------------------------------------- English locale
reply = healthyReply;
localeId = 'en';
registered = [];
instance = createInstance();
let english = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  english = flatten(renderNow(sectionEntry.component, {}));
} catch (error) { english = `THREW: ${error.message}`; }
check(!english.startsWith('THREW'), 'the en locale path renders');
check(english.includes('Expose keys to the model'), 'the en locale uses the English dictionary');
check(english.includes('default platform'), 'the en locale labels the default platform');
check(!english.includes('已配置'), 'no Chinese text leaks into the English page');

// ------------------------------------------------------------- teardown
for (const effect of effects) {
  if (typeof effect.dispose === 'function') effect.dispose();
}
check(styles.every((style) => style.parentNode === null), 'the stylesheet is removed on teardown');

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all client-half checks passed');
}
