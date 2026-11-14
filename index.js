/**
 * Host half of `dsh-apikeys-plugin`.
 *
 * One credential store for many API platforms, and the tools that let the
 * model use those credentials without ever holding them.
 *
 * 1. Keys live in the Host credential store as `dsh-apikeys/<platform>-<account>`
 *    records, so they never enter configuration, the session log, or a tool
 *    result unless the user explicitly asks.
 * 2. Each account is bound to one platform. A platform fixes the API host and
 *    the shape of its auth header, so a key can only ever be sent where that
 *    platform's API lives — `apikey_call` takes a path, never a URL.
 * 3. A same-origin bridge under `/api/dsh-apikeys` backs the settings page.
 *
 * Every collaborator is a Cordis service resolved through the context, so the
 * bundle keeps loading across Harness versions that keep those seams. The one
 * package import is `@deepseek-ai/schemastery`, because a plugin's `Config` has
 * to be a Schema: without it the Host cannot project a configuration form, and
 * the plugin's row on the Plugins page has no configure control.
 *
 * Optional layers, all off by default so an existing install keeps behaving
 * exactly as it did:
 *   - vault: encrypt the keys at rest, unlocked by a master password
 *   - audit: a hash-chained record of who touched which account
 *   - redact: strip credential-shaped strings from API responses
 *   - rotation: fail over between accounts of one platform
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createAuditLog } from './lib/audit.js';
import { createRedactor } from './lib/redact.js';
import { createHealthStore } from './lib/state.js';
import { createVaultStore } from './lib/vault-store.js';

const CREDENTIAL_SCOPE = 'dsh-apikeys';
const BRIDGE_PREFIX = '/api/dsh-apikeys';
/** Platform ids and account names are one lowercase alphanumeric word each. */
const NAME_PATTERN = /^[a-z][a-z0-9]*$/;
/** Longer names are a mistake, not an intent, and bloat every credential key. */
const MAX_NAME_LENGTH = 32;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_ACCOUNT = 'default';
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'];
const MAX_REQUEST_BYTES = 64 * 1024;
/** Statuses that mean "this credential will not work" rather than "this call is wrong". */
const ROTATABLE_STATUSES = Object.freeze([401, 403, 429]);
/** Default master password variable; a name, never the value. */
const DEFAULT_PASSWORD_ENV = 'DSH_APIKEYS_MASTER_PASSWORD';

/**
 * Where the plugin keeps its own state.
 *
 * Everything is derived from `DSH_HOME` when it is set, so a profile's files
 * live with that profile rather than in an unrelated home directory.
 */
function dataDir() {
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.length > 0) return path.join(home, 'dsh-apikeys');
  return path.join(os.homedir(), '.dsh', 'dsh-apikeys');
}

/** Resolve a configured path, defaulting into the plugin's data directory. */
function stateFilePath(configured, fallbackName) {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.resolve(configured.trim());
  }
  return path.join(dataDir(), fallbackName);
}

/**
 * Built-in platforms: where the API lives, how a key is presented, and how to
 * prove a key works.
 *
 * `verify` points at an endpoint that answers 200 only for a valid token and
 * names an identity field published in its response, so "it saved" and "it
 * works" stay different facts.
 */
const BUILTIN_PLATFORMS = {
  github: {
    label: 'GitHub',
    baseUrl: 'https://api.github.com',
    envName: 'GITHUB_TOKEN',
    auth: { kind: 'bearer' },
    docs: 'https://github.com/settings/tokens',
    hint: 'Classic token: `repo` for private repositories. Fine-grained: pick the repositories and permissions you need.',
    verify: { path: '/user', identity: 'login' },
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    note: 'Token is never sent anywhere but the configured host.',
  },
  cloudflare: {
    label: 'Cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4',
    envName: 'CLOUDFLARE_API_TOKEN',
    auth: { kind: 'bearer' },
    docs: 'https://dash.cloudflare.com/profile/api-tokens',
    hint: 'Create an API Token (not the Global API Key). Scope it to the zones and permissions you want.',
    verify: { path: '/user/tokens/verify', identity: 'result.status' },
    headers: { accept: 'application/json' },
    note: 'Only API Tokens work here; the legacy Global API Key uses a different header.',
  },
  vercel: {
    label: 'Vercel',
    baseUrl: 'https://api.vercel.com',
    envName: 'VERCEL_TOKEN',
    auth: { kind: 'bearer' },
    docs: 'https://vercel.com/account/tokens',
    hint: 'Account Settings → Tokens → Create. Set a scope and an expiry.',
    verify: { path: '/v2/user', identity: 'user.username' },
    headers: { accept: 'application/json' },
    note: 'A team-scoped token may need a slug or teamId query parameter for team resources.',
  },
  npm: {
    label: 'npm',
    baseUrl: 'https://registry.npmjs.org',
    envName: 'NPM_TOKEN',
    auth: { kind: 'bearer' },
    docs: 'https://www.npmjs.com/settings/~/tokens',
    hint: 'Automation tokens publish without a 2FA prompt; granular tokens must enable "bypass 2FA" to publish.',
    verify: { path: '/-/whoami', identity: 'username' },
    headers: { accept: 'application/json' },
    note: 'Publishing uses PUT on the package path; this plugin never does that on its own.',
  },
  dockerhub: {
    label: 'Docker Hub',
    baseUrl: 'https://hub.docker.com/v2',
    envName: 'DOCKERHUB_TOKEN',
    auth: { kind: 'bearer' },
    docs: 'https://hub.docker.com/settings/security',
    hint: 'Account Settings → Security → New Access Token. Use the token, not your password.',
    verify: { path: '/user', identity: 'username' },
    headers: { accept: 'application/json' },
    note: 'Personal access tokens are read/write or read-only; pick the narrow one.',
  },
  huggingface: {
    label: 'Hugging Face',
    baseUrl: 'https://huggingface.co/api',
    envName: 'HF_TOKEN',
    auth: { kind: 'bearer' },
    docs: 'https://huggingface.co/settings/tokens',
    hint: 'Settings → Access Tokens → New token. "Read" is enough for downloads; "Write" for uploads.',
    verify: { path: '/whoami-v2', identity: 'name' },
    headers: { accept: 'application/json' },
    note: 'A fine-grained token only sees the repositories you scoped it to.',
  },
};

const AUTH_KINDS = ['bearer', 'header', 'x-api-key', 'basic', 'query'];

/** Treat anything that is not a plain object as an empty one. */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Coerce to a rounded finite number, or `fallback`. */
function toInteger(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

/** Clamp a number into `[min, max]`. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Normalize a name that is allowed to be written loosely.
 *
 * Configuration is hand-written, so `defaultPlatform: GitHub` should work. The
 * value is lowercased first and only has to satisfy the grammar afterwards.
 */
function normalizeLooseName(raw) {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().toLowerCase();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return undefined;
  return NAME_PATTERN.test(name) ? name : undefined;
}

/**
 * Normalize an account name, which must already be lowercase.
 *
 * Account names address credential records, so a caller that types `Work`
 * would silently store `work` and then fail to find it by the name it used.
 * Rejecting the mixed-case form is the honest answer: the caller learns the
 * rule instead of getting a record under a name it did not ask for.
 */
function normalizeAccountName(raw) {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return undefined;
  return NAME_PATTERN.test(name) ? name : undefined;
}

/** Resolve one HTTP method; `undefined` means the caller named an unknown one. */
function normalizeMethod(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'GET';
  const method = raw.trim().toUpperCase();
  return METHODS.includes(method) ? method : undefined;
}

/**
 * The row configuration schema.
 *
 * Exporting this is what makes the plugin's row on the Plugins page show a
 * configure control: the Host projects a form from it, and a row whose Config
 * is absent gets no control at all. Defaults here mirror `readConfig`, which
 * stays tolerant of hand-written YAML that predates this schema.
 */
const Config = z.object({
  defaultPlatform: z.string().default('github').description(
    'Platform a tool call uses when it names none.',
  ),
  defaultAccount: z.string().default(DEFAULT_ACCOUNT).description(
    'Account a tool call uses when it names none.',
  ),
  enabledPlatforms: z.array(z.string()).default([
    'github', 'cloudflare', 'vercel', 'npm', 'dockerhub', 'huggingface',
  ]).description('Built-in platforms to expose. Omit to expose every built-in platform.'),
  accounts: z.array(z.object({
    platform: z.string(),
    name: z.string(),
  })).default([]).description(
    'Account names to keep visible before they hold a key. Accounts added from the settings page are remembered for the running process; list them here to survive a restart.',
  ),
  customPlatforms: z.array(z.object({
    id: z.string(),
    label: z.string().default(''),
    baseUrl: z.string(),
    envName: z.string().default(''),
    docs: z.string().default(''),
    hint: z.string().default(''),
    note: z.string().default(''),
    verify: z.object({
      path: z.string().default(''),
      identity: z.string().default(''),
    }).default({ path: '', identity: '' }),
    auth: z.object({
      kind: z.union(['bearer', 'header', 'x-api-key', 'basic', 'query']).default('bearer'),
      header: z.string().default(''),
      scheme: z.string().default(''),
      username: z.string().default(''),
      queryParam: z.string().default(''),
    }).default({}),
    headers: z.dict(z.string()).default({}),
  })).default([]).description(
    'Your own platforms: baseUrl, auth shape, and an optional verification endpoint.',
  ),
  exposeKeys: z.boolean().default(true).description(
    'Whether apikey_key get may return a key value. Turn off to keep keys inside the Host.',
  ),
  envFallback: z.boolean().default(true).description(
    "Fall back to each platform's environment variable for its default account.",
  ),
  maxResponseChars: z.number().default(20000).min(2000).max(400000).description(
    'Response body cap per call, in characters.',
  ),
  requestTimeoutMs: z.number().default(30000).min(1000).max(180000).description(
    'Per-request timeout, in milliseconds.',
  ),
  userAgent: z.string().default('dsh-apikeys').description('User-Agent header sent with each call.'),
  migrateGitHub: z.boolean().default(true).description(
    'Adopt keys the earlier github-only plugin left under dsh-github/<account>.',
  ),
  vault: z.object({
    enabled: z.boolean().default(false).description(
      'Encrypt keys at rest behind a master password. Off by default: an existing install keeps its current behaviour.',
    ),
    file: z.string().default('').description('Vault file path. Empty uses the plugin data directory.'),
    passwordEnv: z.string().default(DEFAULT_PASSWORD_ENV).description(
      'Environment variable holding the master password. The value is never written to disk.',
    ),
    failClosed: z.boolean().default(true).description(
      'When the vault cannot be unlocked, refuse calls that need a key. Off falls back to the credential store.',
    ),
    migrateCredentials: z.boolean().default(true).description(
      'On unlock, move keys from the credential store into the vault and delete the plaintext records.',
    ),
  }).default({}).description('Optional at-rest encryption of stored keys.'),
  audit: z.object({
    enabled: z.boolean().default(true).description(
      'Record who touched which account, without recording key values.',
    ),
    file: z.string().default('').description('Audit file path. Empty uses the plugin data directory.'),
    maxEntries: z.number().default(2000).min(50).max(100000).description('Entries to keep.'),
  }).default({}).description('Hash-chained audit log.'),
  redact: z.object({
    enabled: z.boolean().default(true).description(
      'Replace credential-shaped strings in API responses before they reach the model.',
    ),
    patterns: z.array(z.string()).default([]).description(
      'Extra regular expressions. Empty uses the built-in issuer patterns.',
    ),
    replaceWith: z.string().default('[REDACTED]').description('Replacement text.'),
  }).default({}).description('Response redaction.'),
  health: z.object({
    file: z.string().default('').description(
      'Where verification results are remembered. Empty uses the plugin data directory.',
    ),
  }).default({}).description('Persisted verify results.'),
  rotation: z.object({
    enabled: z.boolean().default(false).description(
      'Fail over to another account of the same platform on a rejected credential. Off keeps accounts strictly isolated.',
    ),
    retryOn: z.array(z.number()).default([...ROTATABLE_STATUSES]).description('Statuses that trigger failover.'),
    cooldownBaseMs: z.number().default(5000).min(100).max(3600000).description('First backoff interval.'),
    cooldownMaxMs: z.number().default(300000).min(100).max(86400000).description('Backoff ceiling.'),
    maxAttempts: z.number().default(3).min(1).max(10).description('Accounts tried per call.'),
  }).default({}).description('Per-platform credential failover.'),
  upload: z.object({
    enabled: z.boolean().default(true).description('Allow apikey_upload to send a local file.'),
    roots: z.array(z.string()).default([]).description(
      'Directories a file may be read from. Empty allows only the working directory and your home directory.',
    ),
    maxFileBytes: z.number().default(26214400).min(1024).max(1073741824).description('Largest file sent.'),
  }).default({}).description('Multipart upload support.'),
});

/** Read the row configuration with defaults and no schema dependency. */
function readConfig(raw) {
  const config = asObject(raw);
  return {
    defaultPlatform: normalizeLooseName(config.defaultPlatform) ?? 'github',
    defaultAccount: normalizeLooseName(config.defaultAccount) ?? DEFAULT_ACCOUNT,
    enabledPlatforms: Array.isArray(config.enabledPlatforms)
      ? config.enabledPlatforms.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
      : Object.keys(BUILTIN_PLATFORMS),
    customPlatforms: Array.isArray(config.customPlatforms) ? config.customPlatforms : [],
    // Declared account names, so an account can exist before it has a key.
    // Without this an account only surfaces once a record exists for it, which
    // makes "add an account, then paste the key" impossible to do in that
    // order.
    accounts: Array.isArray(config.accounts)
      ? config.accounts
          .map((entry) => {
            const row = asObject(entry);
            const platform = normalizeLooseName(row.platform);
            const name = normalizeAccountName(row.name);
            return platform === undefined || name === undefined ? undefined : { platform, name };
          })
          .filter(Boolean)
      : [],
    exposeKeys: config.exposeKeys !== false,
    envFallback: config.envFallback !== false,
    maxResponseChars: clamp(toInteger(config.maxResponseChars, 20000), 2000, 400000),
    requestTimeoutMs: clamp(toInteger(config.requestTimeoutMs, 30000), 1000, 180000),
    userAgent: typeof config.userAgent === 'string' && config.userAgent.trim().length > 0
      ? config.userAgent.trim()
      : 'dsh-apikeys',
    migrateGitHub: config.migrateGitHub !== false,

    // Every layer below defaults to the behaviour an existing install already
    // has, so upgrading the plugin changes nothing until the user opts in.
    vault: (() => {
      const raw2 = asObject(config.vault);
      return {
        enabled: raw2.enabled === true,
        file: stateFilePath(raw2.file, 'vault.json'),
        passwordEnv: typeof raw2.passwordEnv === 'string' && ENV_NAME_PATTERN.test(raw2.passwordEnv.trim())
          ? raw2.passwordEnv.trim()
          : DEFAULT_PASSWORD_ENV,
        failClosed: raw2.failClosed !== false,
        migrateCredentials: raw2.migrateCredentials !== false,
      };
    })(),
    audit: (() => {
      const raw2 = asObject(config.audit);
      return {
        enabled: raw2.enabled !== false,
        file: stateFilePath(raw2.file, 'audit.jsonl'),
        maxEntries: clamp(toInteger(raw2.maxEntries, 2000), 50, 100000),
      };
    })(),
    redact: (() => {
      const raw2 = asObject(config.redact);
      return {
        enabled: raw2.enabled !== false,
        patterns: Array.isArray(raw2.patterns)
          ? raw2.patterns.map((entry) => String(entry)).filter((entry) => entry.length > 0)
          : [],
        replaceWith: typeof raw2.replaceWith === 'string' && raw2.replaceWith.length > 0
          ? raw2.replaceWith
          : '[REDACTED]',
      };
    })(),
    health: {
      file: stateFilePath(asObject(config.health).file, 'health.json'),
    },
    rotation: (() => {
      const raw2 = asObject(config.rotation);
      const retryOn = Array.isArray(raw2.retryOn)
        ? raw2.retryOn.map((entry) => toInteger(entry, 0)).filter((entry) => entry >= 100 && entry < 600)
        : [];
      return {
        enabled: raw2.enabled === true,
        retryOn: retryOn.length > 0 ? retryOn : [...ROTATABLE_STATUSES],
        cooldownBaseMs: clamp(toInteger(raw2.cooldownBaseMs, 5000), 100, 3600000),
        cooldownMaxMs: clamp(toInteger(raw2.cooldownMaxMs, 300000), 100, 86400000),
        maxAttempts: clamp(toInteger(raw2.maxAttempts, 3), 1, 10),
      };
    })(),
    upload: (() => {
      const raw2 = asObject(config.upload);
      const roots = Array.isArray(raw2.roots)
        ? raw2.roots.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
        : [];
      return {
        enabled: raw2.enabled !== false,
        roots,
        maxFileBytes: clamp(toInteger(raw2.maxFileBytes, 26214400), 1024, 1073741824),
      };
    })(),
  };
}

/** Normalize one custom platform row, or `undefined` when it cannot be used. */
function normalizeCustomPlatform(raw) {
  const entry = asObject(raw);
  const id = normalizeLooseName(entry.id);
  if (id === undefined) return undefined;
  const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
  if (!/^https?:\/\//u.test(baseUrl)) return undefined;

  const auth = asObject(entry.auth);
  const kind = AUTH_KINDS.includes(auth.kind) ? auth.kind : 'bearer';
  const headerName = typeof auth.header === 'string' && auth.header.trim().length > 0
    ? auth.header.trim().toLowerCase()
    : undefined;
  if ((kind === 'header' || kind === 'x-api-key') && headerName === undefined) return undefined;

  const verify = asObject(entry.verify);
  return {
    label: typeof entry.label === 'string' && entry.label.trim().length > 0 ? entry.label.trim() : id,
    baseUrl: baseUrl.replace(/\/+$/u, ''),
    envName: typeof entry.envName === 'string' && ENV_NAME_PATTERN.test(entry.envName.trim())
      ? entry.envName.trim()
      : undefined,
    auth: {
      kind,
      ...(headerName === undefined ? {} : { header: headerName }),
      ...(typeof auth.scheme === 'string' && auth.scheme.trim().length > 0 ? { scheme: auth.scheme.trim() } : {}),
      ...(typeof auth.username === 'string' ? { username: auth.username } : {}),
      ...(typeof auth.queryParam === 'string' && auth.queryParam.trim().length > 0
        ? { queryParam: auth.queryParam.trim() }
        : {}),
    },
    docs: typeof entry.docs === 'string' ? entry.docs : undefined,
    hint: typeof entry.hint === 'string' ? entry.hint : undefined,
    note: typeof entry.note === 'string' ? entry.note : undefined,
    verify: typeof verify.path === 'string' && verify.path.startsWith('/')
      ? { path: verify.path, identity: typeof verify.identity === 'string' ? verify.identity : undefined }
      : undefined,
    headers: asObject(entry.headers),
    custom: true,
  };
}

/**
 * Every platform this plugin can serve: enabled built-ins plus usable custom rows.
 * @returns a map keyed by platform id.
 */
function resolvePlatforms(config) {
  const platforms = new Map();
  for (const id of config.enabledPlatforms) {
    const builtin = BUILTIN_PLATFORMS[id];
    if (builtin !== undefined) platforms.set(id, { id, ...builtin, custom: false });
  }
  for (const raw of config.customPlatforms) {
    const custom = normalizeCustomPlatform(raw);
    if (custom !== undefined) {
      const customId = normalizeLooseName(raw.id);
      platforms.set(customId, { id: customId, ...custom });
    }
  }
  return platforms;
}

/** The credential record id for one account: `<platform>-<account>`. */
function recordId(platform, account) {
  return `${platform}-${account}`;
}

/** Build the auth (and static) headers for one key. */
function authHeaders(platform, key) {
  const headers = { ...(platform.headers ?? {}) };
  const auth = platform.auth ?? { kind: 'bearer' };
  const scheme = auth.scheme ?? 'Bearer';

  switch (auth.kind) {
    case 'bearer':
      headers.authorization = `${scheme} ${key}`;
      break;
    case 'header':
      headers[auth.header] = key;
      break;
    case 'x-api-key':
      headers[auth.header] = key;
      if (scheme !== '') headers.authorization = undefined;
      if (headers.authorization === undefined) delete headers.authorization;
      break;
    case 'basic': {
      const user = typeof auth.username === 'string' ? auth.username : '';
      headers.authorization = `Basic ${Buffer.from(`${user}:${key}`, 'utf8').toString('base64')}`;
      break;
    }
    case 'query':
      break;
    default:
      headers.authorization = `${scheme} ${key}`;
  }
  return headers;
}

/** Place key material in the query string for the `query` auth kind. */
function applyQueryAuth(platform, url, key) {
  const auth = platform.auth ?? { kind: 'bearer' };
  if (auth.kind !== 'query') return;
  url.searchParams.set(auth.queryParam ?? 'api_key', key);
}

/**
 * A URL that is safe to return or print.
 *
 * The `query` auth kind puts the credential in the URL itself, and the result
 * carries that URL back to the model — which would hand over the key even with
 * `exposeKeys: false`. Masking happens unconditionally here rather than through
 * the redactor, because it must not depend on a setting the user can turn off.
 */
function describeUrl(url, key, replacement = '[REDACTED]') {
  const rendered = url.toString();
  if (typeof key !== 'string' || key.length === 0) return rendered;
  return rendered.split(key).join(replacement).split(encodeURIComponent(key)).join(replacement);
}

/**
 * Resolve the key behind one account.
 *
 * Order matters and is deliberate:
 *
 *   1. **Vault** — when the vault is on and unlocked, it is the source of truth.
 *      Its keys are the encrypted ones, so falling through on an empty vault
 *      would silently resurrect a plaintext copy.
 *   2. **Credential store** — the behaviour every existing install has, and the
 *      only store when the vault is off.
 *   3. **Environment** — only for a platform's default account, so a named
 *      account can never inherit somebody else's credential.
 *
 * A locked vault with `failClosed` refuses rather than falling through: silently
 * using a plaintext record is exactly the leak the vault exists to prevent.
 * @returns `{ key, source, error? }`; `key` is `undefined` while unconfigured.
 */
async function accountKey(runtime, platform, account) {
  const { config, vault } = runtime;

  if (vault !== undefined && vault.enabled) {
    if (vault.state === 'unlocked') {
      const stored = vault.get(platform.id, account);
      if (stored !== undefined) return { key: stored, source: 'vault' };
    } else if (config.vault.failClosed) {
      return {
        key: undefined,
        source: 'vault-locked',
        error: `the vault is locked${vault.lastError === undefined ? '' : ` (${vault.lastError})`}; `
          + 'set the master password or turn vault.failClosed off to fall back',
      };
    }
  }

  const credentials = runtime.ctx.get('credentials');
  if (credentials === undefined) return { key: undefined, source: 'unavailable' };

  const record = await credentials.readRecord(`${CREDENTIAL_SCOPE}/${recordId(platform.id, account)}`);
  if (record !== undefined && record !== null
    && record.kind === 'api-key'
    && typeof record.key === 'string' && record.key.length > 0) {
    return { key: record.key, source: 'stored' };
  }

  if (account === config.defaultAccount && config.envFallback && platform.envName !== undefined) {
    const hit = await credentials.resolve(platform.envName);
    if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.length > 0) {
      return { key: hit.value, source: hit.source || platform.envName };
    }
  }

  return { key: undefined, source: 'unset' };
}

/** Store or replace one account key. */
async function storeKey(runtime, platform, account, key) {
  const { vault, config } = runtime;
  if (vault !== undefined && vault.enabled && vault.state === 'unlocked') {
    vault.set(platform.id, account, key);
    return 'vault';
  }
  const credentials = runtime.ctx.get('credentials');
  if (credentials === undefined) {
    throw new Error(config.vault.enabled
      ? 'the vault is locked and this profile has no credentials service, so the key cannot be stored'
      : 'this profile has no credentials service, so keys cannot be stored here');
  }
  await credentials.modifyRecord(
    `${CREDENTIAL_SCOPE}/${recordId(platform.id, account)}`,
    async () => ({ kind: 'api-key', key }),
  );
  return 'stored';
}

/** Remove one stored account key from every store it could be in. */
async function removeKey(runtime, platform, account) {
  let removed = false;
  const { vault } = runtime;
  if (vault !== undefined && vault.enabled && vault.state === 'unlocked') {
    removed = vault.remove(platform.id, account) || removed;
  }
  const credentials = runtime.ctx.get('credentials');
  if (credentials !== undefined) {
    await credentials.deleteRecord(`${CREDENTIAL_SCOPE}/${recordId(platform.id, account)}`);
  }
  return removed;
}

/** Every account stored for one platform, with state and no values. */
async function listAccounts(runtime, platform) {
  const { config, vault, declaredAccounts, health } = runtime;
  const credentials = runtime.ctx.get('credentials');
  const names = new Set([config.defaultAccount]);
  for (const declared of config.accounts) {
    if (declared.platform === platform.id) names.add(declared.name);
  }
  // Accounts registered through the settings page before their key was stored.
  for (const declared of declaredAccounts ?? []) {
    if (declared.platform === platform.id) names.add(declared.name);
  }

  if (vault !== undefined && vault.enabled && vault.state === 'unlocked') {
    for (const entry of vault.list()) {
      if (entry.platform === platform.id) names.add(entry.account);
    }
  }

  const prefix = `${CREDENTIAL_SCOPE}/${platform.id}-`;
  if (credentials !== undefined) {
    for (const entry of await credentials.listRecords()) {
      const key = String(entry?.key ?? '');
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (NAME_PATTERN.test(name)) names.add(name);
    }
  }

  const accounts = [];
  for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
    const credential = await accountKey(runtime, platform, name);
    const verification = health?.verification(platform.id, name);
    const cooldownMs = health?.cooldownRemaining(platform.id, name) ?? 0;
    accounts.push({
      name,
      configured: credential.key !== undefined,
      source: credential.source,
      isDefault: name === config.defaultAccount,
      ...(verification === undefined ? {} : {
        lastVerifiedAt: verification.at,
        lastVerifyOk: verification.ok,
        ...(verification.identity === undefined ? {} : { lastVerifyIdentity: verification.identity }),
      }),
      ...(cooldownMs > 0 ? { cooldownMs } : {}),
    });
  }
  return accounts;
}

/** Read one dotted path out of a JSON body, for identity extraction. */
function readPath(value, dotted) {
  if (typeof dotted !== 'string' || dotted.length === 0) return undefined;
  let cursor = value;
  for (const segment of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return typeof cursor === 'string' || typeof cursor === 'number' ? String(cursor) : undefined;
}

/** Compose the caller signal with a request timeout. */
function requestSignal(timeoutMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('the caller cancelled the request'));
  if (signal !== undefined && typeof signal.addEventListener === 'function') {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`no response within ${timeoutMs} ms`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (signal !== undefined && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Parse `Link: <...>; rel="next"` into page numbers. */
function parseLinkPages(header) {
  if (typeof header !== 'string' || header.length === 0) return undefined;
  const pages = {};
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/u.exec(part.trim());
    if (match === null) continue;
    let page;
    try {
      const raw = new URL(match[1], 'https://example.invalid').searchParams.get('page');
      page = raw === null ? undefined : toInteger(raw, undefined);
    } catch {
      page = undefined;
    }
    if (page === undefined) continue;
    if (match[2] === 'next') pages.next = page;
    if (match[2] === 'last') pages.last = page;
  }
  return pages.next === undefined && pages.last === undefined ? undefined : pages;
}

/** Rate-limit headers, when the response carries them. */
function readRateLimit(headers) {
  const limit = toInteger(headers.get('x-ratelimit-limit'), undefined);
  const remaining = toInteger(headers.get('x-ratelimit-remaining'), undefined);
  if (limit === undefined && remaining === undefined) return undefined;
  const reset = toInteger(headers.get('x-ratelimit-reset'), undefined);
  const resource = headers.get('x-ratelimit-resource');
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(reset === undefined ? {} : { reset }),
    ...(typeof resource === 'string' && resource.length > 0 ? { resource } : {}),
  };
}

/**
 * The proxy variables present in this process, if any.
 *
 * Named rather than valued: the point of the hint is to tell the user which knob
 * the runtime might be reading, not to echo their configuration back.
 */
function proxyVariables() {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  return names.filter((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.length > 0;
  });
}

/** One line of guidance for a failed request, when a status suggests one. */
function hintFor(status, remaining, transport) {
  if (status === 0) {
    const proxies = proxyVariables();
    // Node's fetch ignores the proxy environment unless the runtime opts in, so
    // a proxy-only network fails here with no obvious cause. Naming the
    // variables and the switch turns a mystery into a one-line fix.
    const proxyNote = proxies.length === 0
      ? ''
      : ` — ${proxies.join('/')} ${proxies.length === 1 ? 'is' : 'are'} set but Node's fetch only honours `
        + 'them with NODE_USE_ENV_PROXY=1 or node --use-env-proxy';
    return `the request never reached the server${typeof transport === 'string' ? ` (${transport})` : ''}; `
      + `check this machine's network${proxyNote}`;
  }
  if (status === 401) return 'the key is missing, expired, or revoked; check the account and store a new one';
  if (status === 403 && remaining === 0) return 'the rate limit is exhausted; wait until reset or use another account';
  if (status === 403) return 'the key lacks permission for this resource, or a policy blocked the request';
  if (status === 404) return 'the resource does not exist, or this key cannot see it';
  if (status === 422) return 'the request body or query was rejected; read the returned errors';
  if (status === 429) return 'too many requests; back off before retrying';
  return undefined;
}

/**
 * One platform request. The body is read and bounded here so no tool result can
 * carry an unbounded payload into the transcript.
 */
async function platformRequest(config, platform, options) {
  let base;
  try {
    base = new URL(platform.baseUrl);
  } catch {
    throw new Error(`${platform.id}: baseUrl "${platform.baseUrl}" is not a valid http(s) URL`);
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error(`${platform.id}: baseUrl "${platform.baseUrl}" must use http or https`);
  }

  const { signal, dispose } = requestSignal(config.requestTimeoutMs, options.signal);
  let response;
  let text;
  try {
    response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      signal,
      redirect: 'follow',
    });
    text = await response.text();
  } catch (error) {
    // A transport failure is a fact about this call, not a defect in the tool:
    // report it as a failed result so the model can react instead of the turn
    // breaking on a thrown error.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return {
      ok: false,
      status: 0,
      data: '',
      truncated: false,
      transport: error instanceof Error ? error.message : String(error),
    };
  } finally {
    dispose();
  }

  let data = text;
  const contentType = response.headers.get('content-type') ?? '';
  if (/json/iu.test(contentType) || /^\s*[[{]/u.test(text)) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  let truncated = false;
  if (typeof data === 'string') {
    if (data.length > config.maxResponseChars) {
      data = data.slice(0, config.maxResponseChars);
      truncated = true;
    }
  } else {
    const serialized = JSON.stringify(data);
    if (typeof serialized === 'string' && serialized.length > config.maxResponseChars) {
      data = serialized.slice(0, config.maxResponseChars);
      truncated = true;
    }
  }

  const rateLimit = readRateLimit(response.headers);
  const pagination = parseLinkPages(response.headers.get('link'));
  return {
    ok: response.ok,
    status: response.status,
    data,
    truncated,
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...(pagination === undefined ? {} : { pagination }),
  };
}

/** Build the request URL from the platform base plus a relative path. */
function buildUrl(platform, path, query) {
  const base = new URL(platform.baseUrl);
  const prefix = base.pathname.replace(/\/+$/u, '');
  const url = new URL(`${prefix}${path}`, base.origin);
  if (url.origin !== base.origin) {
    throw new Error(`${platform.id} refused to leave its configured host`);
  }
  for (const [name, value] of Object.entries(asObject(query))) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return url;
}

/** Text helper for tool rendering. */
function text(body) {
  return [{ type: 'text', text: body }];
}

const CALL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Whether the platform answered with a 2xx status.' },
    status: { type: 'integer', description: 'HTTP status code.' },
    platform: { type: 'string', description: 'Platform id the request went to.' },
    method: { type: 'string', description: 'HTTP method used.' },
    url: { type: 'string', description: 'Full request URL, including any query string.' },
    account: { type: 'string', description: 'Credential account that authorized the call.' },
    credentialSource: {
      type: 'string',
      description: '`vault`, `stored`, an environment source name, `unset` (anonymous call) or `unavailable`.',
    },
    truncated: { type: 'boolean', description: 'Whether the response body was cut to the configured limit.' },
    data: { description: 'Parsed JSON body, or raw text when the body is not JSON.' },
    rotated: {
      type: 'integer',
      description: 'How many credentials were tried before this answer, when rotation is on.',
    },
    uploaded: {
      type: 'array',
      description: 'Files sent with this request, as field name and byte count.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string' },
          filename: { type: 'string' },
          bytes: { type: 'integer' },
        },
        required: ['field', 'filename', 'bytes'],
      },
    },
    rateLimit: {
      type: 'object',
      additionalProperties: false,
      description: 'Rate-limit headers when present.',
      properties: {
        limit: { type: 'integer' },
        remaining: { type: 'integer' },
        reset: { type: 'integer', description: 'Unix seconds at which the window resets.' },
        resource: { type: 'string' },
      },
    },
    pagination: {
      type: 'object',
      additionalProperties: false,
      description: 'Page numbers taken from the Link header.',
      properties: {
        next: { type: 'integer' },
        last: { type: 'integer' },
      },
    },
    hint: { type: 'string', description: 'What the status usually means, on a failed request.' },
    transport: {
      type: 'string',
      description: 'The transport failure text when status is 0 and the request never reached the server.',
    },
  },
  required: ['ok', 'status', 'platform', 'method', 'url', 'account', 'credentialSource', 'truncated', 'data'],
};

/** Render one `apikey_call` result as the model-facing text. */
function renderCall(_args, value) {
  const lines = [value.status === 0
    ? `${value.method} ${value.url} -> no response`
    : `${value.method} ${value.url} -> ${value.status}${value.ok ? '' : ' (failed)'}`];
  lines.push(`platform: ${value.platform} · account: ${value.account} (${value.credentialSource})`);
  if (value.rateLimit !== undefined && value.rateLimit.remaining !== undefined) {
    const limit = value.rateLimit.limit === undefined ? '?' : String(value.rateLimit.limit);
    lines.push(`rate limit: ${value.rateLimit.remaining}/${limit} remaining`);
  }
  if (value.pagination !== undefined) {
    const parts = [];
    if (value.pagination.next !== undefined) parts.push(`next=${value.pagination.next}`);
    if (value.pagination.last !== undefined) parts.push(`last=${value.pagination.last}`);
    if (parts.length > 0) lines.push(`pages: ${parts.join(' ')}`);
  }
  if (value.truncated) lines.push('note: the response body was truncated');
  if (value.hint !== undefined) lines.push(`hint: ${value.hint}`);
  lines.push('');
  if (typeof value.data === 'string') {
    lines.push(value.data.length === 0 ? '(empty body)' : value.data);
  } else {
    lines.push(JSON.stringify(value.data, null, 2));
  }
  return text(lines.join('\n'));
}

const PLATFORMS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    platforms: {
      type: 'array',
      description: 'Every platform this plugin can serve, with its accounts.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          baseUrl: { type: 'string' },
          custom: { type: 'boolean', description: 'Whether the platform came from configuration.' },
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                configured: { type: 'boolean' },
                source: { type: 'string' },
                isDefault: { type: 'boolean' },
              },
              required: ['name', 'configured', 'source', 'isDefault'],
            },
          },
        },
        required: ['id', 'label', 'baseUrl', 'custom', 'accounts'],
      },
    },
    defaultPlatform: { type: 'string' },
    defaultAccount: { type: 'string' },
    envFallback: { type: 'boolean' },
    storeAvailable: { type: 'boolean', description: 'Whether this profile has a credentials service.' },
  },
  required: ['platforms', 'defaultPlatform', 'defaultAccount', 'envFallback', 'storeAvailable'],
};

function renderPlatforms(_args, value) {
  const lines = [];
  if (value.platforms.length === 0) lines.push('no platforms are enabled');
  for (const platform of value.platforms) {
    lines.push(`${platform.id}${platform.id === value.defaultPlatform ? ' [default platform]' : ''} — ${platform.baseUrl}`);
    for (const account of platform.accounts) {
      const state = account.configured ? `configured (${account.source})` : 'no key';
      lines.push(`  - ${account.name}${account.isDefault ? ' [default account]' : ''}: ${state}`);
    }
  }
  if (value.envFallback) lines.push('fallback: each platform\'s environment variable (e.g. GITHUB_TOKEN) is used for its default account when no key is stored');
  if (!value.storeAvailable) lines.push('this profile has no credentials service; keys cannot be stored');
  return text(lines.join('\n'));
}

const KEY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    platform: { type: 'string' },
    account: { type: 'string' },
    configured: { type: 'boolean' },
    source: { type: 'string' },
    value: { type: 'string', description: 'The key, for action "get" only.' },
    message: { type: 'string' },
  },
  required: ['ok', 'action', 'platform', 'account', 'configured'],
};

function renderKey(_args, value) {
  if (value.action === 'get') {
    if (value.ok && typeof value.value === 'string') {
      return text(`${value.platform} · ${value.account} (${value.source})\n${value.value}`);
    }
    return text(`${value.platform} · ${value.account} is not configured${value.message === undefined ? '' : `: ${value.message}`}`);
  }
  if (value.action === 'set') return text(`${value.platform} · ${value.account} stored`);
  return text(`${value.platform} · ${value.account} removed`);
}

/**
 * Candidate accounts for one call, in the order to try them.
 *
 * With rotation off this is exactly the requested account — accounts stay
 * isolated, which is the default and the behaviour every existing install has.
 *
 * With rotation on, accounts that are cooling down go last: the point of the
 * backoff is to stop hammering a credential the platform just rejected, so
 * retrying it first would waste the very attempt the cooldown exists to avoid.
 * It is still never dropped entirely — if every account is cooling, the
 * requested one is tried rather than failing without asking anyone.
 */
async function callCandidates(runtime, platform, requested) {
  const { config } = runtime;
  if (config.rotation.enabled !== true) return [requested];

  const accounts = await listAccounts(runtime, platform);
  const configured = accounts.filter((account) => account.configured === true);
  const healthy = configured.filter((account) => (account.cooldownMs ?? 0) === 0);
  const cooling = configured.filter((account) => (account.cooldownMs ?? 0) > 0);

  const ordered = [];
  const requestedEntry = accounts.find((account) => account.name === requested);
  const requestedIsCooling = (requestedEntry?.cooldownMs ?? 0) > 0;

  // The requested account leads when it is usable; otherwise the healthy pool
  // leads and it is held back as a last resort.
  if (!requestedIsCooling) ordered.push(requested);
  for (const account of healthy) {
    if (account.name === requested) continue;
    ordered.push(account.name);
  }
  for (const account of cooling) {
    if (account.name === requested) continue;
    ordered.push(account.name);
  }
  if (requestedIsCooling) ordered.push(requested);

  const unique = [...new Set(ordered)].slice(0, config.rotation.maxAttempts);
  return unique.length > 0 ? unique : [requested];
}

/**
 * Perform one platform request, selecting and failing over between credentials.
 *
 * Every branch that could leak the key is handled here rather than in the tool:
 * the response body is redacted before it becomes a result, and the audit log
 * records the attempt without recording the key.
 */
async function performCall(runtime, options) {
  const { config, platforms, health, redactor, audit } = runtime;
  const platform = platforms.get(options.platform);
  const candidates = await callCandidates(runtime, platform, options.account);
  const attempts = [];
  let last;

  for (let index = 0; index < candidates.length; index += 1) {
    const account = candidates[index];
    const credential = await accountKey(runtime, platform, account);
    if (credential.error !== undefined) throw new Error(credential.error);

    const url = buildUrl(platform, options.path, options.query);
    if (credential.key !== undefined) applyQueryAuth(platform, url, credential.key);
    const headers = credential.key === undefined
      ? { 'user-agent': config.userAgent, ...(platform.headers ?? {}) }
      : { 'user-agent': config.userAgent, ...authHeaders(platform, credential.key) };

    const response = await platformRequest(config, platform, {
      url,
      method: options.method,
      headers: {
        ...headers,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body,
      signal: options.signal,
    });

    // Redact against the exact key this attempt used: that is the one an
    // unhelpful error message would echo back.
    const data = redactor.redactValue(response.data, credential.key === undefined ? [] : [credential.key]);
    const attempt = {
      account,
      status: response.status,
      ok: response.ok,
      credentialSource: credential.key === undefined ? 'unset' : credential.source,
      ...(response.transport === undefined ? {} : { transport: response.transport }),
    };
    attempts.push(attempt);

    last = { url, account, credential, response, data };

    const rotatable = config.rotation.retryOn.includes(response.status);
    const more = index < candidates.length - 1;
    if (response.ok || !rotatable || !more) break;

    // This credential is not usable right now; back it off and try the next.
    health.markFailure(platform.id, account, {
      baseMs: config.rotation.cooldownBaseMs,
      maxMs: config.rotation.cooldownMaxMs,
    });
  }

  if (last === undefined) {
    // Every candidate was unconfigured. Still do the anonymous request so a
    // public endpoint keeps working, exactly as before.
    const url = buildUrl(platform, options.path, options.query);
    const response = await platformRequest(config, platform, {
      url,
      method: options.method,
      headers: { 'user-agent': config.userAgent, ...(platform.headers ?? {}) },
      body: options.body,
      signal: options.signal,
    });
    last = {
      url,
      account: options.account,
      credential: { key: undefined, source: 'unset' },
      response,
      data: redactor.redactValue(response.data, []),
    };
  }

  const { url, account, credential, response, data } = last;
  if (response.ok) health.markSuccess(platform.id, account);

  audit?.append({
    actor: options.actor ?? 'tool',
    action: 'call',
    platform: platform.id,
    account,
    detail: {
      method: options.method,
      path: options.path,
      status: response.status,
      attempts: attempts.length > 1 ? attempts : undefined,
      redacted: data !== response.data ? true : undefined,
    },
  });

  const hint = response.ok
    ? undefined
    : hintFor(response.status, response.rateLimit?.remaining, response.transport);

  return {
    ok: response.ok,
    status: response.status,
    platform: platform.id,
    method: options.method,
    url: describeUrl(url, credential.key),
    account,
    credentialSource: credential.key === undefined ? 'unset' : credential.source,
    truncated: response.truncated,
    data,
    ...(attempts.length > 1 ? { rotated: attempts.length } : {}),
    ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
    ...(response.pagination === undefined ? {} : { pagination: response.pagination }),
    ...(hint === undefined ? {} : { hint }),
    ...(response.transport === undefined ? {} : { transport: response.transport }),
  };
}

/**
 * Resolve one upload path, refusing anything outside the allowed roots.
 *
 * A model that can name any absolute path could send `/etc/shadow` or an SSH
 * key to a third party. The allowlist is what makes an upload tool safe to
 * expose at all: it can only reach files the operator already placed somewhere
 * the plugin is willing to read.
 */
async function resolveUploadFile(config, requested) {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    throw new Error('apikey_upload requires a file "path"');
  }
  const resolved = path.resolve(requested.trim());
  const roots = config.upload.roots.length > 0
    ? config.upload.roots.map((root) => path.resolve(root))
    : [process.cwd(), os.homedir()];

  const allowed = roots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!allowed) {
    throw new Error(
      `apikey_upload refused ${resolved}: it is outside the allowed roots (${roots.join(', ')}). `
      + 'List a directory in upload.roots to permit it.',
    );
  }

  let info;
  try {
    info = await fs.promises.stat(resolved);
  } catch {
    throw new Error(`apikey_upload cannot read ${resolved}`);
  }
  if (!info.isFile()) throw new Error(`apikey_upload needs a file, not something else: ${resolved}`);
  if (info.size > config.upload.maxFileBytes) {
    throw new Error(
      `apikey_upload: ${resolved} is ${info.size} bytes, over the ${config.upload.maxFileBytes}-byte limit`,
    );
  }
  return { path: resolved, size: info.size, bytes: await fs.promises.readFile(resolved) };
}

/**
 * Register the tools in the scope that resolved the `tools` service.
 * @param runtime - shared plugin state: ctx, config, platforms, and the optional layers.
 */
function registerTools(runtime) {
  const { ctx, config, platforms, audit, redactor, health } = runtime;
  const platformIds = [...platforms.keys()];

  ctx.tools.register({
    name: 'apikey_call',
    description:
      'Call an API on one of the user\'s configured platforms using its stored key. `platform` picks the '
      + 'service (which fixes the host), `path` is relative to that platform\'s API base, and `query`/`body` '
      + 'carry parameters and JSON. Returns status, parsed body (bounded), rate-limit and page numbers. '
      + `Available platforms: ${platformIds.join(', ')}. Ask apikey_platforms which accounts exist first.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platform: {
          type: 'string',
          description: `Platform id. One of: ${platformIds.join(', ')}.`,
        },
        path: {
          type: 'string',
          description: 'Path on the platform\'s API host, starting with "/". Absolute URLs are refused.',
        },
        method: {
          type: 'string',
          enum: METHODS,
          default: 'GET',
          description: 'HTTP method. Use GET for reads, POST to create, PATCH to update, DELETE to remove.',
        },
        account: {
          type: 'string',
          description: 'Named credential account. Defaults to the configured default account.',
        },
        query: {
          type: 'object',
          additionalProperties: true,
          description: 'Query string parameters as name/value pairs; objects are sent as JSON.',
        },
        body: {
          title: 'JSON request body',
          description: 'Request body for POST, PATCH, PUT and DELETE. Omit it for GET.',
        },
      },
      required: ['platform', 'path'],
    },
    output: { schema: CALL_OUTPUT_SCHEMA, render: renderCall },
    isConcurrencySafe(args) {
      return normalizeMethod(asObject(args).method) === 'GET';
    },
    async execute(args, exec) {
      const input = asObject(args);
      const platformId = normalizeLooseName(input.platform);
      if (platformId === undefined) {
        throw new Error(`apikey_call "platform" must be one of: ${platformIds.join(', ')}`);
      }
      const platform = platforms.get(platformId);
      if (platform === undefined) {
        throw new Error(
          `apikey_call "platform" is "${platformId}", which is not enabled here. `
          + `Enabled platforms: ${platformIds.join(', ')}.`,
        );
      }

      const method = normalizeMethod(input.method);
      if (method === undefined) {
        throw new Error(`apikey_call method must be one of ${METHODS.join(', ')}`);
      }

      const path = typeof input.path === 'string' ? input.path.trim() : '';
      if (path.length === 0) {
        throw new Error(`apikey_call requires "path", for example "/user"`);
      }
      if (!path.startsWith('/') || path.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)) {
        throw new Error(`apikey_call "path" must be a path on ${platformId}'s host, starting with "/"`);
      }

      let account;
      if (input.account === undefined || input.account === null || input.account === '') {
        account = config.defaultAccount;
      } else {
        account = normalizeAccountName(input.account);
        if (account === undefined) {
          throw new Error(
            'apikey_call "account" must be lowercase letters and digits, starting with a letter '
            + `(got ${JSON.stringify(String(input.account))})`,
          );
        }
      }

      const body = input.body !== undefined && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')
        ? JSON.stringify(input.body)
        : undefined;

      return performCall(runtime, {
        platform: platformId,
        method,
        path,
        query: input.query,
        body,
        account,
        signal: exec.signal,
        actor: 'tool:apikey_call',
      });
    },
  });

  ctx.tools.register({
    name: 'apikey_platforms',
    description:
      'List the API platforms configured in this Harness and the credential accounts stored for each: '
      + 'whether a key is configured and where it comes from. Never returns key values. Use it to choose '
      + 'the platform and account for apikey_call, or to tell the user which platform still needs a key.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: PLATFORMS_OUTPUT_SCHEMA, render: renderPlatforms },
    isConcurrencySafe: () => true,
    async execute() {
      const rows = [];
      for (const platform of platforms.values()) {
        rows.push({
          id: platform.id,
          label: platform.label,
          baseUrl: platform.baseUrl,
          custom: platform.custom === true,
          accounts: await listAccounts(runtime, platform),
        });
      }
      return {
        platforms: rows,
        defaultPlatform: config.defaultPlatform,
        defaultAccount: config.defaultAccount,
        envFallback: config.envFallback,
        storeAvailable: ctx.get('credentials') !== undefined,
      };
    },
  });

  ctx.tools.register({
    name: 'apikey_key',
    description:
      'Read or manage one platform API key by account name. action "get" returns the key itself and is '
      + (config.exposeKeys ? 'enabled here' : 'disabled by this plugin\'s configuration')
      + '; use it only when the user asks for the key or needs it for another service. '
      + 'action "set" stores a key the user supplied; action "clear" removes the stored key and falls '
      + 'back to the platform\'s environment reference, if any.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'clear'],
          description: '`get` reveals the key, `set` stores one, `clear` removes the stored one.',
        },
        platform: {
          type: 'string',
          description: `Platform id. One of: ${platformIds.join(', ')}.`,
        },
        account: {
          type: 'string',
          description: 'Account name (lowercase letters and digits). Defaults to the configured default account.',
        },
        value: {
          type: 'string',
          description: 'The key to store; required for action "set" and ignored otherwise.',
        },
      },
      required: ['action', 'platform'],
    },
    output: { schema: KEY_OUTPUT_SCHEMA, render: renderKey },
    async execute(args, exec) {
      const input = asObject(args);
      const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
      if (action !== 'get' && action !== 'set' && action !== 'clear') {
        throw new Error('apikey_key "action" must be "get", "set" or "clear"');
      }
      const platformId = normalizeLooseName(input.platform);
      const platform = platformId === undefined ? undefined : platforms.get(platformId);
      if (platform === undefined) {
        throw new Error(`apikey_key "platform" must be one of: ${platformIds.join(', ')}`);
      }
      const account = input.account === undefined || input.account === null || input.account === ''
        ? config.defaultAccount
        : normalizeAccountName(input.account);
      if (account === undefined) {
        throw new Error(
          'apikey_key "account" must be lowercase letters and digits, starting with a letter '
          + `(got ${JSON.stringify(String(input.account))})`,
        );
      }

      if (action === 'get') {
        if (!config.exposeKeys) {
          throw new Error(
            'apikey_key cannot reveal keys: exposeKeys is false in this plugin\'s configuration. '
            + 'Use apikey_call so the key stays inside the Host, or ask the user to change exposeKeys.',
          );
        }
        if (exec.signal !== undefined && exec.signal.aborted) throw new Error('apikey_key was cancelled');
        const credential = await accountKey(runtime, platform, account);
        if (credential.error !== undefined) throw new Error(credential.error);
        audit?.append({
          actor: 'tool:apikey_key', action: 'key.get',
          platform: platform.id, account, detail: { ok: credential.key !== undefined },
        });
        if (credential.key === undefined) {
          return {
            ok: false,
            action,
            platform: platform.id,
            account,
            configured: false,
            source: credential.source,
            message: 'no key is stored for this account and no environment fallback applies',
          };
        }
        return {
          ok: true,
          action,
          platform: platform.id,
          account,
          configured: true,
          source: credential.source,
          value: credential.key,
        };
      }

      if (action === 'set') {
        const value = typeof input.value === 'string' ? input.value.trim() : '';
        if (value.length === 0) throw new Error('apikey_key action "set" requires a non-empty "value"');
        if (value.length > 8192) throw new Error('apikey_key "value" is longer than any API key');
        const where = await storeKey(runtime, platform, account, value);
        audit?.append({
          actor: 'tool:apikey_key', action: 'key.set',
          platform: platform.id, account, detail: { store: where },
        });
        return { ok: true, action, platform: platform.id, account, configured: true, source: where };
      }

      await removeKey(runtime, platform, account);
      audit?.append({ actor: 'tool:apikey_key', action: 'key.clear', platform: platform.id, account });
      const remaining = await accountKey(runtime, platform, account);
      return {
        ok: true,
        action,
        platform: platform.id,
        account,
        configured: remaining.key !== undefined,
        source: remaining.source,
      };
    },
  });

  ctx.tools.register({
    name: 'apikey_upload',
    description:
      'Send a multipart/form-data request to one of the configured platforms, reading the file from this '
      + 'machine. Use it for endpoints that take a file rather than JSON — Hugging Face model uploads, '
      + 'GitHub release assets, artifact stores. The key stays on the Host: only the path is yours, the '
      + 'credential is attached here. Paths must sit under upload.roots (the working directory and your '
      + `home directory by default). Available platforms: ${platformIds.join(', ')}.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platform: { type: 'string', description: `Platform id. One of: ${platformIds.join(', ')}.` },
        path: {
          type: 'string',
          description: 'Path on the platform\'s API host, starting with "/". Absolute URLs are refused.',
        },
        method: {
          type: 'string',
          enum: ['POST', 'PUT', 'PATCH'],
          default: 'POST',
          description: 'HTTP method. Most upload endpoints take POST or PUT.',
        },
        account: { type: 'string', description: 'Named credential account. Defaults to the default account.' },
        fields: {
          type: 'object',
          additionalProperties: true,
          description: 'Plain form fields sent alongside the files, as name/value pairs.',
        },
        files: {
          type: 'array',
          description: 'Files to send, in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string', description: 'Form field name, for example "file".' },
              path: { type: 'string', description: 'Local file path on this machine.' },
              filename: { type: 'string', description: 'Filename to present. Defaults to the basename.' },
              contentType: { type: 'string', description: 'MIME type. Defaults to application/octet-stream.' },
            },
            required: ['field', 'path'],
          },
        },
        query: {
          type: 'object',
          additionalProperties: true,
          description: 'Query string parameters as name/value pairs.',
        },
      },
      required: ['platform', 'path', 'files'],
    },
    output: { schema: CALL_OUTPUT_SCHEMA, render: renderCall },
    async execute(args, exec) {
      const input = asObject(args);
      if (config.upload.enabled !== true) {
        throw new Error('apikey_upload is turned off: set upload.enabled to true to allow file uploads');
      }
      const platformId = normalizeLooseName(input.platform);
      const platform = platformId === undefined ? undefined : platforms.get(platformId);
      if (platform === undefined) {
        throw new Error(`apikey_upload "platform" must be one of: ${platformIds.join(', ')}`);
      }
      const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : 'POST';
      if (!['POST', 'PUT', 'PATCH'].includes(method)) {
        throw new Error('apikey_upload "method" must be POST, PUT or PATCH');
      }
      const path2 = typeof input.path === 'string' ? input.path.trim() : '';
      if (!path2.startsWith('/') || path2.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path2)) {
        throw new Error(`apikey_upload "path" must be a path on ${platformId}'s host, starting with "/"`);
      }
      const account = input.account === undefined || input.account === null || input.account === ''
        ? config.defaultAccount
        : normalizeAccountName(input.account);
      if (account === undefined) {
        throw new Error('apikey_upload "account" must be lowercase letters and digits, starting with a letter');
      }
      const requested = Array.isArray(input.files) ? input.files : [];
      if (requested.length === 0) throw new Error('apikey_upload requires at least one file');

      const files = [];
      const uploaded = [];
      for (const entry of requested) {
        const row = asObject(entry);
        const field = typeof row.field === 'string' ? row.field.trim() : '';
        if (field.length === 0) throw new Error('apikey_upload: every file needs a "field" name');
        const resolved = await resolveUploadFile(config, row.path);
        const filename = typeof row.filename === 'string' && row.filename.length > 0
          ? row.filename
          : path.basename(resolved.path);
        const contentType = typeof row.contentType === 'string' && row.contentType.length > 0
          ? row.contentType
          : 'application/octet-stream';
        files.push({ field, filename, contentType, bytes: resolved.bytes });
        uploaded.push({ field, filename, bytes: resolved.size });
      }

      const credential = await accountKey(runtime, platform, account);
      if (credential.error !== undefined) throw new Error(credential.error);

      const url = buildUrl(platform, path2, input.query);
      if (credential.key !== undefined) applyQueryAuth(platform, url, credential.key);

      // FormData sets its own boundary; setting content-type by hand would
      // break the request, so only the auth headers are merged here.
      const form = new FormData();
      for (const [name, value] of Object.entries(asObject(input.fields))) {
        if (value === undefined || value === null) continue;
        form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      for (const file of files) {
        form.append(file.field, new Blob([file.bytes], { type: file.contentType }), file.filename);
      }

      const headers = credential.key === undefined
        ? { 'user-agent': config.userAgent, ...(platform.headers ?? {}) }
        : { 'user-agent': config.userAgent, ...authHeaders(platform, credential.key) };

      const response = await platformRequest(config, platform, {
        url, method, headers, body: form, signal: exec.signal,
      });
      const data = redactor.redactValue(response.data, credential.key === undefined ? [] : [credential.key]);
      if (response.ok) health.markSuccess(platform.id, account);

      const totalBytes = uploaded.reduce((sum, file) => sum + file.bytes, 0);
      audit?.append({
        actor: 'tool:apikey_upload', action: 'call', platform: platform.id, account,
        detail: {
          method, path: path2, status: response.status,
          files: uploaded.map((file) => ({ filename: file.filename, bytes: file.bytes })),
          totalBytes,
        },
      });

      const hint = response.ok
        ? undefined
        : hintFor(response.status, response.rateLimit?.remaining, response.transport);
      return {
        ok: response.ok,
        status: response.status,
        platform: platform.id,
        method,
        url: describeUrl(url, credential.key),
        account,
        credentialSource: credential.key === undefined ? 'unset' : credential.source,
        truncated: response.truncated,
        data,
        uploaded,
        ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
        ...(response.pagination === undefined ? {} : { pagination: response.pagination }),
        ...(hint === undefined ? {} : { hint }),
        ...(response.transport === undefined ? {} : { transport: response.transport }),
      };
    },
  });
}

/** Whether one HTTP request may reach the key bridge. */
function isBridgeRequestAllowed(request, trust) {
  const host = request.headers?.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;

  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }

  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);

  if (trust.hosts.includes(hostname) || trust.hosts.includes(host)) return true;
  const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
    || hostname.endsWith('.localhost');
  if (!loopback) {
    const local = request.socket?.localAddress;
    if (typeof local !== 'string' || local === '0.0.0.0' || local === '::') return false;
    if (local.toLowerCase() !== hostname) return false;
  }
  const remote = request.socket?.remoteAddress;
  if (typeof remote !== 'string') return false;
  return remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
}

/** Write one JSON response. */
function writeJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  response.end(payload);
}

/** Read one bounded JSON body; `undefined` means malformed or oversized. */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return undefined;
  }
}

/** The bridge surface the Client page uses. */
function createBridge(runtime, trust) {
  const { ctx, config, platforms, audit, health } = runtime;
  const status = async () => {
    const rows = [];
    for (const platform of platforms.values()) {
      rows.push({
        id: platform.id,
        label: platform.label,
        baseUrl: platform.baseUrl,
        custom: platform.custom === true,
        docs: platform.docs,
        hint: platform.hint,
        note: platform.note,
        envName: platform.envName,
        accounts: await listAccounts(runtime, platform),
      });
    }
    return {
      platforms: rows,
      defaultPlatform: config.defaultPlatform,
      defaultAccount: config.defaultAccount,
      envFallback: config.envFallback,
      exposeKeys: config.exposeKeys,
      storeAvailable: ctx.get('credentials') !== undefined,
      // The settings page shows these so a locked vault or a cooling account is
      // visible rather than looking like a broken plugin.
      vault: {
        enabled: config.vault.enabled,
        state: runtime.vault?.state ?? 'disabled',
        file: config.vault.enabled ? config.vault.file : undefined,
        failClosed: config.vault.failClosed,
        passwordEnv: config.vault.passwordEnv,
        lastError: runtime.vault?.lastError,
      },
      rotation: {
        enabled: config.rotation.enabled,
        retryOn: config.rotation.retryOn,
        cooldowns: health.cooldowns(),
      },
      redact: { enabled: config.redact.enabled },
      audit: {
        enabled: config.audit.enabled,
        entries: audit?.size() ?? 0,
        file: config.audit.enabled ? config.audit.file : undefined,
      },
      upload: {
        enabled: config.upload.enabled,
        roots: config.upload.roots.length > 0 ? config.upload.roots : [process.cwd(), os.homedir()],
        maxFileBytes: config.upload.maxFileBytes,
      },
    };
  };

  const pick = (body) => {
    const platformId = normalizeLooseName(body.platform);
    const platform = platformId === undefined ? undefined : platforms.get(platformId);
    const account = normalizeAccountName(body.account ?? config.defaultAccount);
    return { platform, account, platformId };
  };

  const handlers = {
    async status() {
      return { ok: true, value: await status() };
    },

    async set(body) {
      const { platform, account } = pick(body);
      if (platform === undefined) {
        return { ok: false, code: 'unknown-platform', message: 'that platform is not enabled here' };
      }
      if (account === undefined) {
        return { ok: false, code: 'invalid-account', message: 'account must be lowercase letters and digits' };
      }
      const key = typeof body.token === 'string' ? body.token.trim() : '';
      if (key.length === 0) return { ok: false, code: 'empty-token', message: 'the key is empty' };
      if (key.length > 8192) return { ok: false, code: 'long-token', message: 'the key is longer than any API key' };
      const where = await storeKey(runtime, platform, account, key);
      audit?.append({ actor: "user", action: "key.set", platform: platform.id, account, detail: { store: where } });
      return { ok: true, value: await status() };
    },

    async clear(body) {
      const { platform, account } = pick(body);
      if (platform === undefined) {
        return { ok: false, code: 'unknown-platform', message: 'that platform is not enabled here' };
      }
      if (account === undefined) {
        return { ok: false, code: 'invalid-account', message: 'account must be lowercase letters and digits' };
      }
      await removeKey(runtime, platform, account);
      audit?.append({ actor: "user", action: "key.clear", platform: platform.id, account });
      // Clearing a key is how a user retires an account. Drop the registration
      // too, or the name stays visible with no key and looks like an account
      // still waiting to be filled in.
      const index = runtime.declaredAccounts.findIndex(
        (row) => row.platform === platform.id && row.name === account,
      );
      if (index >= 0) runtime.declaredAccounts.splice(index, 1);
      return { ok: true, value: await status() };
    },

    /**
     * Remove an account outright: its stored key and its registration.
     *
     * Withdrawing an account is not the same as clearing its key, and it must
     * work whether or not a key was ever stored — an account created but never
     * filled in is exactly the one a user wants to take back. The default
     * account is refused: unnamed calls fall back to it.
     */
    async removeAccount(body) {
      const { platform, account } = pick(body);
      if (platform === undefined) {
        return { ok: false, code: 'unknown-platform', message: 'that platform is not enabled here' };
      }
      if (account === undefined) {
        return { ok: false, code: 'invalid-account', message: 'account must be lowercase letters and digits, at most 32' };
      }
      if (account === config.defaultAccount) {
        return {
          ok: false,
          code: 'default-account',
          message: `"${account}" is this platform's default account and cannot be removed; it is what unnamed calls fall back to`,
        };
      }
      await removeKey(runtime, platform, account);
      audit?.append({ actor: "user", action: "key.clear", platform: platform.id, account });
      const index = runtime.declaredAccounts.findIndex(
        (row) => row.platform === platform.id && row.name === account,
      );
      if (index >= 0) runtime.declaredAccounts.splice(index, 1);
      return { ok: true, value: await status() };
    },

    /**
     * Register an account name before it has a key.
     *
     * An account is otherwise only discoverable through its credential record,
     * so creating one and then pasting a key — the natural order — used to lose
     * the account on the next refresh. The registration is kept in memory for
     * this process only; the account becomes durable as soon as a key is stored.
     */
    async addAccount(body) {
      const { platform, account } = pick(body);
      if (platform === undefined) {
        return { ok: false, code: 'unknown-platform', message: 'that platform is not enabled here' };
      }
      if (account === undefined) {
        return { ok: false, code: 'invalid-account', message: 'account must be lowercase letters and digits, at most 32' };
      }
      if (!runtime.declaredAccounts.some((row) => row.platform === platform.id && row.name === account)) {
        runtime.declaredAccounts.push({ platform: platform.id, name: account });
      }
      return { ok: true, value: await status() };
    },

    async verify(body) {
      const { platform, account } = pick(body);
      if (platform === undefined) {
        return { ok: false, code: 'unknown-platform', message: 'that platform is not enabled here' };
      }
      if (account === undefined) {
        return { ok: false, code: 'invalid-account', message: 'account must be lowercase letters and digits' };
      }
      if (platform.verify === undefined) {
        return { ok: false, code: 'no-verify', message: 'this platform does not declare a verification endpoint' };
      }

      const credential = await accountKey(runtime, platform, account);
      if (credential.error !== undefined) {
        return { ok: false, code: 'vault-locked', message: credential.error };
      }
      if (credential.key === undefined) {
        return { ok: false, code: 'no-token', message: `no key is stored for "${account}"` };
      }

      const url = buildUrl(platform, platform.verify.path, undefined);
      applyQueryAuth(platform, url, credential.key);
      const response = await platformRequest(config, platform, {
        url,
        method: 'GET',
        headers: { 'user-agent': config.userAgent, ...authHeaders(platform, credential.key) },
      });

      if (!response.ok) {
        const message = hintFor(response.status, response.rateLimit?.remaining, response.transport)
          ?? `${platform.label} answered ${response.status}`;
        // A verify is the user asking "does this still work", so remember the
        // answer: the badge should not go stale the moment the page reloads.
        health.recordVerification(platform.id, account, { ok: false, status: response.status, message });
        audit?.append({
          actor: 'user', action: 'verify', platform: platform.id, account,
          detail: { ok: false, status: response.status },
        });
        return { ok: false, code: `${platform.id}-${response.status}`, message };
      }

      const identity = readPath(response.data, platform.verify.identity);
      health.recordVerification(platform.id, account, { ok: true, status: response.status, identity });
      health.markSuccess(platform.id, account);
      audit?.append({
        actor: 'user', action: 'verify', platform: platform.id, account,
        detail: { ok: true, status: response.status, identity: identity ?? null },
      });

      return {
        ok: true,
        value: {
          platform: platform.id,
          account,
          source: credential.source,
          identity,
          status: response.status,
        },
      };
    },

    /** Show the audit trail, newest first, with a chain verdict. */
    async auditLog(body) {
      if (config.audit.enabled !== true) {
        return { ok: false, code: 'audit-disabled', message: 'the audit log is turned off' };
      }
      const limit = clamp(toInteger(asObject(body).limit, 100), 1, 500);
      return {
        ok: true,
        value: {
          entries: audit.list(limit),
          total: audit.size(),
          chain: audit.verify(),
        },
      };
    },

    /**
     * Unlock the vault for this process.
     *
     * The password arrives over the same-origin bridge, is used to derive the
     * key, and is never stored: reloading the page locks it again unless the
     * password is also present in the configured environment variable.
     */
    async unlock(body) {
      if (runtime.vault === undefined || runtime.vault.enabled !== true) {
        return { ok: false, code: 'vault-disabled', message: 'the vault is not enabled in the configuration' };
      }
      const candidate = typeof asObject(body).password === 'string' ? asObject(body).password : '';
      if (candidate.length === 0) {
        return { ok: false, code: 'empty-password', message: 'the master password is empty' };
      }
      const result = runtime.vault.unlock(candidate);
      audit?.append({
        actor: 'user', action: result.ok ? 'vault.unlock' : 'vault.lock',
        detail: { ok: result.ok, reason: result.reason ?? null },
      });
      if (!result.ok) {
        return { ok: false, code: 'wrong-password', message: result.reason ?? 'the vault did not open' };
      }
      await migrateIntoVault(runtime);
      return { ok: true, value: await status() };
    },

    /** Forget the master password and the decrypted keys. */
    async lock() {
      runtime.vault?.lock();
      audit?.append({ actor: 'user', action: 'vault.lock', detail: { ok: true } });
      return { ok: true, value: await status() };
    },
  };

  const routes = [
    ['/status', 'status'],
    ['/add-account', 'addAccount'],
    ['/remove-account', 'removeAccount'],
    ['/set', 'set'],
    ['/clear', 'clear'],
    ['/verify', 'verify'],
    ['/audit', 'auditLog'],
    ['/unlock', 'unlock'],
    ['/lock', 'lock'],
  ];

  return routes.map(([suffix, name]) => ({
    kind: 'exact',
    path: `${BRIDGE_PREFIX}${suffix}`,
    async handler(request, response) {
      if (!isBridgeRequestAllowed(request, trust)) {
        writeJson(response, 403, {
          ok: false,
          code: 'forbidden',
          message: 'the API key bridge only answers same-origin requests from this machine',
        });
        return;
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, {
          ok: false,
          code: 'method-not-allowed',
          message: `use POST, not ${request.method ?? 'an unknown method'}`,
        });
        return;
      }
      const body = await readJson(request);
      if (body === undefined) {
        writeJson(response, 400, { ok: false, code: 'malformed-body', message: 'the request body is not JSON' });
        return;
      }
      try {
        writeJson(response, 200, await handlers[name](body));
      } catch (error) {
        writeJson(response, 200, {
          ok: false,
          code: 'bridge-failure',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }));
}

/**
 * Adopt a key the earlier GitHub-only plugin stored under `dsh-github/<account>`.
 * It only runs once per account, never overwrites a key the new layout already
 * holds, and never deletes the old record.
 */
async function migrateFromGitHubPlugin(runtime) {
  const { ctx, config, audit } = runtime;
  const credentials = ctx.get('credentials');
  if (credentials === undefined || config.migrateGitHub !== true) return;

  for (const entry of await credentials.listRecords()) {
    const key = String(entry?.key ?? '');
    if (!key.startsWith('dsh-github/')) continue;
    const account = normalizeAccountName(key.slice('dsh-github/'.length));
    if (account === undefined) continue;

    // When the vault is on and unlocked it is the destination, so the adopted
    // key lands encrypted rather than as a fresh plaintext record.
    if (runtime.vault !== undefined && runtime.vault.enabled && runtime.vault.state === 'unlocked') {
      if (runtime.vault.get('github', account) !== undefined) continue;
      const previous = await credentials.readRecord(key);
      if (previous === undefined || previous === null
        || previous.kind !== 'api-key'
        || typeof previous.key !== 'string' || previous.key.length === 0) continue;
      runtime.vault.set('github', account, previous.key);
      audit?.append({
        actor: 'migration', action: 'vault.migrate', platform: 'github', account,
        detail: { from: 'dsh-github (earlier plugin layout)', to: 'vault' },
      });
      ctx.logger?.info?.(`apikeys: adopted the GitHub key for "${account}" from the earlier plugin layout into the vault`);
      continue;
    }

    const target = `${CREDENTIAL_SCOPE}/${recordId('github', account)}`;
    if (await credentials.readRecord(target) !== undefined) continue;

    const previous = await credentials.readRecord(key);
    if (previous === undefined || previous === null
      || previous.kind !== 'api-key'
      || typeof previous.key !== 'string' || previous.key.length === 0) continue;

    await credentials.modifyRecord(target, async () => ({ kind: 'api-key', key: previous.key }));
    ctx.logger?.info?.(`apikeys: adopted the GitHub key for account "${account}" from the earlier plugin layout`);
  }
}

/**
 * Move keys from the credential store into the vault.
 *
 * At-rest encryption only means something if the plaintext copy goes away, so
 * this deletes each record the vault has taken. It runs on unlock, is skipped
 * when `vault.migrateCredentials` is false, and never deletes a record it could
 * not first write to the vault.
 *
 * This is also the upgrade path for anyone who has been using the plugin with
 * the credential store: turning the vault on moves their keys in, and nothing
 * has to be re-entered.
 */
async function migrateIntoVault(runtime) {
  const { ctx, config, vault, audit } = runtime;
  if (vault === undefined || vault.enabled !== true || vault.state !== 'unlocked') return { moved: 0 };
  if (config.vault.migrateCredentials !== true) return { moved: 0 };

  const credentials = ctx.get('credentials');
  if (credentials === undefined) return { moved: 0 };

  let moved = 0;
  for (const entry of await credentials.listRecords()) {
    const recordKey = String(entry?.key ?? '');
    if (!recordKey.startsWith(`${CREDENTIAL_SCOPE}/`)) continue;
    const id = recordKey.slice(CREDENTIAL_SCOPE.length + 1);
    // `<platform>-<account>`; platform ids and account names carry no dash, so
    // the single separator is unambiguous.
    const separator = id.indexOf('-');
    if (separator <= 0) continue;
    const platform = normalizeLooseName(id.slice(0, separator));
    const account = normalizeAccountName(id.slice(separator + 1));
    if (platform === undefined || account === undefined) continue;

    const record = await credentials.readRecord(recordKey);
    if (record === undefined || record === null
      || record.kind !== 'api-key'
      || typeof record.key !== 'string' || record.key.length === 0) continue;

    try {
      if (vault.get(platform, account) === undefined) {
        vault.set(platform, account, record.key);
      }
      // Only remove the plaintext after the encrypted copy is written.
      await credentials.deleteRecord(recordKey);
      moved += 1;
      audit?.append({
        actor: 'migration', action: 'vault.migrate', platform, account,
        detail: { from: 'credential store', to: 'vault' },
      });
    } catch (error) {
      ctx.logger?.warn?.(`apikeys: could not move ${recordKey} into the vault: ${String(error)}`);
    }
  }
  if (moved > 0) ctx.logger?.info?.(`apikeys: moved ${moved} key(s) from the credential store into the vault`);
  return { moved };
}

/**
 * Mount the tools and the bridge. Each registration is an effect owned by this
 * plugin, so unloading removes both surfaces.
 * @param ctx - the plugin context.
 * @param rawConfig - the row configuration from `cordis.patch.yml`.
 */
function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  const platforms = resolvePlatforms(config);

  // Everything mutable about this plugin, shared by the tools and the bridge so
  // both see the same vault, the same audit chain and the same health state.
  const runtime = {
    ctx,
    config,
    platforms,
    // Account names registered from the settings page but not yet backed by a
    // stored key.
    declaredAccounts: [],
    vault: createVaultStore({ file: config.vault.file, enabled: config.vault.enabled }),
    audit: config.audit.enabled
      ? createAuditLog({ file: config.audit.file, maxEntries: config.audit.maxEntries })
      : undefined,
    redactor: createRedactor({
      enabled: config.redact.enabled,
      patterns: config.redact.patterns,
      replaceWith: config.redact.replaceWith,
    }),
    health: createHealthStore({ file: config.health.file }),
  };

  // Trusted authorities for the key bridge. The deployment's own trusted hosts
  // join this list when the Web startup facts are available; without them the
  // bridge answers loopback requests only.
  const trust = { hosts: [] };

  // Unlock the vault as early as the environment allows. A missing password is
  // not an error: the plugin stays usable and the settings page offers unlock.
  if (config.vault.enabled) {
    const password = process.env[config.vault.passwordEnv];
    if (typeof password === 'string' && password.length > 0) {
      const result = runtime.vault.unlock(password);
      if (result.ok) {
        runtime.audit?.append({ actor: 'startup', action: 'vault.unlock', detail: { ok: true, source: 'environment' } });
      } else {
        ctx.logger?.warn?.(`apikeys: the vault did not unlock from ${config.vault.passwordEnv}: ${result.reason}`);
      }
    } else if (runtime.vault.exists()) {
      ctx.logger?.warn?.(
        `apikeys: the vault is locked — set ${config.vault.passwordEnv} or unlock it in Settings → API Keys`,
      );
    }
  }

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      registerTools(runtime);
      return () => {};
    }, 'dsh-apikeys: tools');
  });

  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => {
      const disposers = createBridge(runtime, trust)
        .map((route) => serverCtx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-apikeys: key bridge');
  });

  ctx.inject(['credentials'], (credentialsCtx) => {
    credentialsCtx.effect(() => {
      let cancelled = false;
      const run = async () => {
        await migrateFromGitHubPlugin(runtime);
        if (runtime.vault.enabled && runtime.vault.state === 'unlocked') {
          await migrateIntoVault(runtime);
        }
      };
      run().catch((error) => {
        if (!cancelled) ctx.logger?.warn?.(`apikeys: key migration failed: ${String(error)}`);
      });
      return () => {
        cancelled = true;
      };
    }, 'dsh-apikeys: adopt earlier keys');
  });

  ctx.inject(['webStartup'], (startupCtx) => {
    startupCtx.effect(() => {
      const startup = startupCtx.get('webStartup');
      const hosts = [];
      const trusted = Array.isArray(startup?.trustedHosts) ? startup.trustedHosts : [];
      for (const entry of trusted) {
        if (typeof entry !== 'string' || entry.trim().length === 0) continue;
        hosts.push(entry.trim().toLowerCase());
      }
      if (typeof startup?.publicUrl === 'string' && startup.publicUrl.length > 0) {
        try {
          hosts.push(new URL(startup.publicUrl).host.toLowerCase());
        } catch {
          // A malformed publicUrl simply contributes nothing.
        }
      }
      trust.hosts.splice(0, trust.hosts.length, ...hosts);
      return () => {
        trust.hosts.length = 0;
      };
    }, 'dsh-apikeys: bridge trust');
  });

  // Drop the decrypted keys when the plugin unloads.
  ctx.effect(() => () => {
    runtime.vault?.lock();
  }, 'dsh-apikeys: wipe the vault on unload');

  ctx.logger?.info?.(
    `apikeys: ${platforms.size} platform(s) [${[...platforms.keys()].join(', ')}], `
    + `default ${config.defaultPlatform}/${config.defaultAccount}, `
    + `key reveal ${config.exposeKeys ? 'enabled' : 'disabled'}, `
    + `environment fallback ${config.envFallback ? 'on' : 'off'}, `
    + `vault ${config.vault.enabled ? runtime.vault.state : 'off'}, `
    + `audit ${config.audit.enabled ? 'on' : 'off'}, `
    + `redact ${config.redact.enabled ? 'on' : 'off'}, `
    + `rotation ${config.rotation.enabled ? 'on' : 'off'}`,
  );
}

export { Config, apply };
export const name = 'apikeys';
// Surfaced for the out-of-band CLI, which needs the same platform table and the
// same config interpretation the plugin uses — one authority, not a copy.
export { BUILTIN_PLATFORMS, readConfig, resolvePlatforms };
