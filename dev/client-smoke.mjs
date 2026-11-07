/**
 * Client-half smoke test for dsh-github-plugin.
 *
 * It materializes the browser bundle through the real `__ModuleLoader__`
 * contract, mounts `apply()` against a fake Client context, and renders both
 * slot entries the way the shell would: a hook store persists across renders,
 * effects run after a render commits, and awaited effects settle before the
 * next render. A throwing component therefore fails here rather than blanking
 * a seat in the browser.
 */
import { importPlugin } from './_shared.mjs';

const failures = [];
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
}

// ------------------------------------------------------------ fake React
/** One component instance: a persistent hook store plus one render cursor. */
function createInstance() {
  return { hooks: [], cursor: 0, effects: [], ranEffects: new Set() };
}
let instance = createInstance();

const React = {
  createElement(type, props, ...children) {
    const combined = { ...(props || {}), children: children.length === 0 ? undefined : children };
    // Function components are rendered in place so their hooks are collected.
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

/** Render once, then run any not-yet-run effect this commit scheduled. */
async function render(component, props) {
  instance.cursor = 0;
  instance.effects = [];
  const tree = component(props);
  const pending = instance.effects.filter((entry) => !instance.ranEffects.has(entry.index));
  for (const entry of pending) {
    instance.ranEffects.add(entry.index);
    const cleanup = entry.effect();
    if (typeof cleanup === 'function') cleanup();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return tree;
}

/** Render against the committed hook store without scheduling effects again. */
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
let reply = {
  ok: true,
  value: {
    accounts: [{ name: 'default', configured: true, source: 'stored', isDefault: true }],
    defaultAccount: 'default', envFallback: true, envName: 'GITHUB_TOKEN',
    exposeKeys: true, baseUrl: 'https://api.github.com', storeAvailable: true,
  },
};
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init.body, headers: init.headers });
  return { ok: true, status: 200, async json() { return reply; } };
};

// --------------------------------------------------- materialize the bundle
let registration;
globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry; } } };
await importPlugin('client.js');
check(registration !== undefined, 'the bundle registers one factory');
check(registration.id === 'dsh-github-plugin', 'the factory id is the package name');

const exportsObject = registration.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected module request: ${name}`);
});
check(exportsObject && typeof exportsObject.apply === 'function', 'the factory returns apply()');
check(Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'), 'the client half injects slots');

// ---------------------------------------------------------------- mount it
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
check(styles.length === 1 && styles[0].dataset.plugin === 'dsh-github', 'the stylesheet is inserted once');

const rowEntry = registered.find((entry) => entry.options.name === 'plugins.row.config');
const sectionEntry = registered.find((entry) => entry.options.name === 'settings.section');
check(rowEntry !== undefined, 'the row entry exists');
check(rowEntry.options.key === 'dsh-github-plugin#github-tools', 'the row key is <package>#<patch row id>');
check(sectionEntry.options.id === 'github', 'the settings section uses its own id');
check(sectionEntry.options.order === 34, 'the settings section has an order');
check(typeof sectionEntry.options.label === 'function' && sectionEntry.options.label() === 'GitHub', 'the section label resolves');

// ----------------------------------------------------------- render trees
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

function safeRender(component, props) {
  try {
    instance = createInstance();
    return flatten(component(props));
  } catch (error) {
    return `THREW: ${error.message}`;
  }
}

instance = createInstance();
const summary = safeRender(rowEntry.component, { view: 'summary' });
check(summary.includes('github_api'), 'the summary line names the tools');

// ------------------------------------------------------- the loaded page
instance = createInstance();
let page = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  page = flatten(renderNow(sectionEntry.component, {}));
} catch (error) {
  page = `THREW: ${error.message}`;
}
check(!page.startsWith('THREW'), `the page renders without throwing (${page.slice(0, 40)}…)`);
check(page.includes('GitHub'), 'the loaded page carries the section title');
check(page.includes('https://api.github.com'), 'the loaded page shows the API host');
check(page.includes('github_api'), 'the loaded page lists the tools');
check(page.includes('已配置'), 'the loaded page reports the configured account');
check(page.includes('在 GitHub 上创建 Token'), 'the loaded page links to token creation');
check(calls.length > 0 && calls[0].url === '/api/dsh-github/status', 'the page asks the host bridge for status');
check(calls[0].headers['content-type'] === 'application/json', 'the bridge call is JSON');

// ------------------------------------------------------ unreachable Host
reply = { ok: false, code: 'network', message: 'boom' };
instance = createInstance();
let unreachable = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  unreachable = flatten(renderNow(sectionEntry.component, {}));
} catch (error) {
  unreachable = `THREW: ${error.message}`;
}
check(!unreachable.startsWith('THREW'), 'a failed bridge call renders a message instead of crashing');
check(unreachable.includes('无法访问'), 'the failure message is localized');

// -------------------------------------------------- unconfigured, then en
reply = {
  ok: true,
  value: {
    accounts: [{ name: 'default', configured: false, source: 'unset', isDefault: true }],
    defaultAccount: 'default', envFallback: false, envName: 'GITHUB_TOKEN',
    exposeKeys: false, baseUrl: 'https://api.github.com', storeAvailable: true,
  },
};
instance = createInstance();
let emptyPage = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  emptyPage = flatten(renderNow(sectionEntry.component, {}));
} catch (error) {
  emptyPage = `THREW: ${error.message}`;
}
check(!emptyPage.startsWith('THREW'), 'an unconfigured account still renders');
check(emptyPage.includes('未配置'), 'the unconfigured state is shown');
check(emptyPage.includes('已关闭'), 'exposeKeys:false is shown as off');

localeId = 'en';
registered = [];
injected = [];
instance = createInstance();
let englishPage = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  englishPage = flatten(renderNow(sectionEntry.component, {}));
} catch (error) {
  englishPage = `THREW: ${error.message}`;
}
check(!englishPage.startsWith('THREW'), 'the en locale path renders');
check(englishPage.includes('Expose tokens to the model'), 'the en locale uses the English dictionary');
check(englishPage.includes('API host'), 'the en locale labels the host row');
check(!englishPage.includes('API 主机'), 'no Chinese text leaks into the English page');

// Confirm the zh path a second time through a fresh mount, so the locale
// service is the only difference between the two renders.
localeId = 'zh';
registered = [];
instance = createInstance();
let chinesePage = 'THREW: no render';
try {
  await renderTwice(sectionEntry.component, {});
  chinesePage = flatten(renderNow(sectionEntry.component, {}));
} catch (error) {
  chinesePage = `THREW: ${error.message}`;
}
check(chinesePage.includes('API 主机'), 'the zh locale labels the host row');
check(!chinesePage.includes('API host'), 'no English text leaks into the Chinese page');

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
