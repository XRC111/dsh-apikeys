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
 * The module imports nothing. Every collaborator is a Cordis service resolved
 * through the context, so the bundle keeps loading across Harness versions
 * that keep those seams.
 */

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
 * Resolve the key behind one account.
 *
 * A stored record always wins. Only the platform's default account may fall
 * back to the platform's environment reference, so a named account can never
 * silently inherit somebody else's credential.
 * @returns `{ key, source }`; `key` is `undefined` while unconfigured.
 */
async function accountKey(ctx, config, platform, account) {
  const credentials = ctx.get('credentials');
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
async function storeKey(ctx, platform, account, key) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) {
    throw new Error('this profile has no credentials service, so keys cannot be stored here');
  }
  await credentials.modifyRecord(
    `${CREDENTIAL_SCOPE}/${recordId(platform.id, account)}`,
    async () => ({ kind: 'api-key', key }),
  );
}

/** Remove one stored account key. Removing an absent record is a no-op. */
async function removeKey(ctx, platform, account) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) {
    throw new Error('this profile has no credentials service, so there is nothing to remove');
  }
  await credentials.deleteRecord(`${CREDENTIAL_SCOPE}/${recordId(platform.id, account)}`);
}

/** Every account stored for one platform, with state and no values. */
async function listAccounts(ctx, config, platform, declaredAccounts) {
  const credentials = ctx.get('credentials');
  const names = new Set([config.defaultAccount]);
  for (const declared of config.accounts) {
    if (declared.platform === platform.id) names.add(declared.name);
  }
  // Accounts registered through the settings page before their key was stored.
  for (const declared of declaredAccounts ?? []) {
    if (declared.platform === platform.id) names.add(declared.name);
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
    const credential = await accountKey(ctx, config, platform, name);
    accounts.push({
      name,
      configured: credential.key !== undefined,
      source: credential.source,
      isDefault: name === config.defaultAccount,
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

/** One line of guidance for a failed request, when a status suggests one. */
function hintFor(status, remaining, transport) {
  if (status === 0) {
    return `the request never reached the server${typeof transport === 'string' ? ` (${transport})` : ''}; `
      + 'check this machine\'s network and any proxy in the launch environment';
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
      description: '`stored`, an environment source name, `unset` (anonymous call) or `unavailable`.',
    },
    truncated: { type: 'boolean', description: 'Whether the response body was cut to the configured limit.' },
    data: { description: 'Parsed JSON body, or raw text when the body is not JSON.' },
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
 * Register the three tools in the scope that resolved the `tools` service.
 * @param ctx - context owning `tools` and `credentials`.
 * @param config - normalized row configuration.
 * @param platforms - resolved platform map.
 */
function registerTools(ctx, config, platforms, declaredAccounts) {
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

      const url = buildUrl(platform, path, input.query);
      const credential = await accountKey(ctx, config, platform, account);
      if (credential.key !== undefined) applyQueryAuth(platform, url, credential.key);

      const headers = credential.key === undefined
        ? { 'user-agent': config.userAgent, ...(platform.headers ?? {}) }
        : { 'user-agent': config.userAgent, ...authHeaders(platform, credential.key) };

      const body = input.body !== undefined && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')
        ? JSON.stringify(input.body)
        : undefined;

      const response = await platformRequest(config, platform, {
        url,
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body,
        signal: exec.signal,
      });

      const hint = response.ok
        ? undefined
        : hintFor(response.status, response.rateLimit?.remaining, response.transport);
      return {
        ok: response.ok,
        status: response.status,
        platform: platformId,
        method,
        url: url.toString(),
        account,
        credentialSource: credential.key === undefined ? 'unset' : credential.source,
        truncated: response.truncated,
        data: response.data,
        ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
        ...(response.pagination === undefined ? {} : { pagination: response.pagination }),
        ...(hint === undefined ? {} : { hint }),
        ...(response.transport === undefined ? {} : { transport: response.transport }),
      };
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
          accounts: await listAccounts(ctx, config, platform, declaredAccounts),
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
        const credential = await accountKey(ctx, config, platform, account);
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
        await storeKey(ctx, platform, account, value);
        return { ok: true, action, platform: platform.id, account, configured: true, source: 'stored' };
      }

      await removeKey(ctx, platform, account);
      const remaining = await accountKey(ctx, config, platform, account);
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
function createBridge(ctx, config, platforms, trust, declaredAccounts) {
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
        accounts: await listAccounts(ctx, config, platform, declaredAccounts),
      });
    }
    return {
      platforms: rows,
      defaultPlatform: config.defaultPlatform,
      defaultAccount: config.defaultAccount,
      envFallback: config.envFallback,
      exposeKeys: config.exposeKeys,
      storeAvailable: ctx.get('credentials') !== undefined,
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
      await storeKey(ctx, platform, account, key);
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
      await removeKey(ctx, platform, account);
      // Clearing a key is how a user retires an account. Drop the registration
      // too, or the name stays visible with no key and looks like an account
      // still waiting to be filled in.
      const index = declaredAccounts.findIndex(
        (row) => row.platform === platform.id && row.name === account,
      );
      if (index >= 0) declaredAccounts.splice(index, 1);
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
      if (!declaredAccounts.some((row) => row.platform === platform.id && row.name === account)) {
        declaredAccounts.push({ platform: platform.id, name: account });
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

      const credential = await accountKey(ctx, config, platform, account);
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
        return {
          ok: false,
          code: `${platform.id}-${response.status}`,
          message: hintFor(response.status, response.rateLimit?.remaining, response.transport)
            ?? `${platform.label} answered ${response.status}`,
        };
      }

      return {
        ok: true,
        value: {
          platform: platform.id,
          account,
          source: credential.source,
          identity: readPath(response.data, platform.verify.identity),
          status: response.status,
        },
      };
    },
  };

  const routes = [
    ['/status', 'status'],
    ['/add-account', 'addAccount'],
    ['/set', 'set'],
    ['/clear', 'clear'],
    ['/verify', 'verify'],
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
async function migrateFromGitHubPlugin(ctx, config) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined || config.migrateGitHub !== true) return;

  for (const entry of await credentials.listRecords()) {
    const key = String(entry?.key ?? '');
    if (!key.startsWith('dsh-github/')) continue;
    const account = normalizeAccountName(key.slice('dsh-github/'.length));
    if (account === undefined) continue;

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
 * Mount the tools and the bridge. Each registration is an effect owned by this
 * plugin, so unloading removes both surfaces.
 * @param ctx - the plugin context.
 * @param rawConfig - the row configuration from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  const platforms = resolvePlatforms(config);
  // Account names registered from the settings page but not yet backed by a
  // stored key. Shared by the tools and the bridge so both see the same set.
  const declaredAccounts = [];
  // Trusted authorities for the key bridge. The deployment's own trusted hosts
  // join this list when the Web startup facts are available; without them the
  // bridge answers loopback requests only.
  const trust = { hosts: [] };

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      registerTools(toolsCtx, config, platforms, declaredAccounts);
      return () => {};
    }, 'dsh-apikeys: tools');
  });

  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => {
      const disposers = createBridge(serverCtx, config, platforms, trust, declaredAccounts)
        .map((route) => serverCtx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-apikeys: key bridge');
  });

  ctx.inject(['credentials'], (credentialsCtx) => {
    credentialsCtx.effect(() => {
      let cancelled = false;
      migrateFromGitHubPlugin(credentialsCtx, config).catch((error) => {
        if (!cancelled) ctx.logger?.warn?.(`apikeys: could not adopt the earlier GitHub key: ${String(error)}`);
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

  ctx.logger?.info?.(
    `apikeys: ${platforms.size} platform(s) [${[...platforms.keys()].join(', ')}], `
    + `default ${config.defaultPlatform}/${config.defaultAccount}, `
    + `key reveal ${config.exposeKeys ? 'enabled' : 'disabled'}, `
    + `environment fallback ${config.envFallback ? 'on' : 'off'}`,
  );
}
