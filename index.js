/**
 * Host half of `dsh-github-plugin`.
 *
 * It owns three things and nothing else:
 *
 * 1. A named token store on top of the Host `credentials` service. Tokens are
 *    kept as `dsh-github/<account>` credential *records*, so they never enter
 *    configuration, the session log, or a tool result unless the user asks.
 *    When a name has no record, the default account may fall back to the
 *    `GITHUB_TOKEN` reference (environment / `.env`), which the credentials
 *    service already layers for every other key.
 * 2. The model-facing tools `github_api`, `github_accounts` and `github_key`.
 * 3. The same-origin bridge under `/api/dsh-github` that the Client page calls
 *    to list, store, verify and remove tokens.
 *
 * The module imports nothing. Every collaborator is a Cordis service resolved
 * through the context (`tools`, `webServer`, `credentials`, `webStartup`), so
 * the bundle keeps loading across Harness versions that keep those seams.
 */

const CREDENTIAL_SCOPE = 'dsh-github';
const BRIDGE_PREFIX = '/api/dsh-github';
const ACCOUNT_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_ACCOUNT = 'default';
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'];
const MAX_REQUEST_BYTES = 64 * 1024;

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

/** Lowercase account names are the only thing `credentialKey` accepts. */
function normalizeAccount(raw) {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().toLowerCase();
  return ACCOUNT_PATTERN.test(name) ? name : undefined;
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
  const trimmed = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  return {
    baseUrl: (trimmed.length > 0 ? trimmed : 'https://api.github.com').replace(/\/+$/u, ''),
    defaultAccount: normalizeAccount(config.defaultAccount) ?? DEFAULT_ACCOUNT,
    exposeKeys: config.exposeKeys !== false,
    envFallback: config.envFallback !== false,
    envName: typeof config.envName === 'string' && ENV_NAME_PATTERN.test(config.envName.trim())
      ? config.envName.trim()
      : 'GITHUB_TOKEN',
    maxResponseChars: clamp(toInteger(config.maxResponseChars, 20000), 2000, 400000),
    requestTimeoutMs: clamp(toInteger(config.requestTimeoutMs, 30000), 1000, 180000),
    apiVersion: typeof config.apiVersion === 'string' && config.apiVersion.trim().length > 0
      ? config.apiVersion.trim()
      : '2022-11-28',
    userAgent: typeof config.userAgent === 'string' && config.userAgent.trim().length > 0
      ? config.userAgent.trim()
      : 'dsh-github',
  };
}

/**
 * Resolve the token behind one account name.
 *
 * A stored record always wins; the environment reference is consulted only for
 * the default account and only while `envFallback` is on, so a named account
 * can never silently inherit somebody else's token.
 *
 * @returns `{ token, source }`; `token` is `undefined` while unconfigured.
 */
async function accountToken(ctx, config, account) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) return { token: undefined, source: 'unavailable' };

  const record = await credentials.readRecord(`${CREDENTIAL_SCOPE}/${account}`);
  if (record !== undefined && record !== null
    && record.kind === 'api-key'
    && typeof record.key === 'string' && record.key.length > 0) {
    return { token: record.key, source: 'stored' };
  }

  if (account === config.defaultAccount && config.envFallback) {
    const hit = await credentials.resolve(config.envName);
    if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.length > 0) {
      return { token: hit.value, source: hit.source || config.envName };
    }
  }

  return { token: undefined, source: 'unset' };
}

/** Store or replace one account token. */
async function storeToken(ctx, config, account, token) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) {
    throw new Error('this profile has no credentials service, so GitHub tokens cannot be stored here');
  }
  const key = `${CREDENTIAL_SCOPE}/${account}`;
  await credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: token }));
  return { token, source: 'stored' };
}

/** Remove one stored account token. Removing an absent record is a no-op. */
async function removeToken(ctx, account) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) {
    throw new Error('this profile has no credentials service, so there is nothing to remove');
  }
  await credentials.deleteRecord(`${CREDENTIAL_SCOPE}/${account}`);
}

/** Every account this plugin knows about, with its configured state and no values. */
async function listAccounts(ctx, config) {
  const credentials = ctx.get('credentials');
  const names = new Set([config.defaultAccount]);

  if (credentials !== undefined) {
    for (const entry of await credentials.listRecords()) {
      const key = String(entry?.key ?? '');
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      if (key.slice(0, slash) !== CREDENTIAL_SCOPE) continue;
      const name = key.slice(slash + 1);
      if (ACCOUNT_PATTERN.test(name)) names.add(name);
    }
  }

  const accounts = [];
  for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
    const credential = await accountToken(ctx, config, name);
    accounts.push({
      name,
      configured: credential.token !== undefined,
      source: credential.source,
      isDefault: name === config.defaultAccount,
    });
  }
  return accounts;
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
      const raw = new URL(match[1], 'https://api.github.com').searchParams.get('page');
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
  const used = toInteger(headers.get('x-ratelimit-used'), undefined);
  const reset = toInteger(headers.get('x-ratelimit-reset'), undefined);
  const resource = headers.get('x-ratelimit-resource');
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(used === undefined ? {} : { used }),
    ...(reset === undefined ? {} : { reset }),
    ...(typeof resource === 'string' && resource.length > 0 ? { resource } : {}),
  };
}

/** One line of guidance for a failed request, when a status suggests one. */
function hintFor(status, remaining) {
  if (status === 401) return 'the token is missing, expired, or revoked; check the account in github_accounts and store a new one';
  if (status === 403 && remaining === 0) return 'the API rate limit is exhausted; wait until reset or use a different account';
  if (status === 403) return 'the token lacks permission for this resource, or a GitHub policy blocked the request';
  if (status === 404) return 'the resource does not exist, or this token cannot see it (GitHub hides private resources as 404)';
  if (status === 422) return 'GitHub rejected the request body or query; read the returned errors';
  if (status === 429) return 'too many requests; back off before retrying';
  return undefined;
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

/**
 * One GitHub request. The body is read and bounded here so no tool result can
 * carry an unbounded payload into the transcript.
 */
async function githubRequest(config, options) {
  let base;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error(`github: baseUrl "${config.baseUrl}" is not a valid http(s) URL`);
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error(`github: baseUrl "${config.baseUrl}" must use http or https`);
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

/** Build the request URL from the configured host plus a relative path. */
function buildUrl(config, path, query) {
  const base = new URL(config.baseUrl);
  const prefix = base.pathname.replace(/\/+$/u, '');
  const url = new URL(`${prefix}${path}`, base.origin);
  if (url.origin !== base.origin) {
    throw new Error('github_api refused to leave the configured GitHub host');
  }
  for (const [name, value] of Object.entries(asObject(query))) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return url;
}

/** Shared headers for every GitHub request. */
function githubHeaders(config, token) {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': config.apiVersion,
    'user-agent': config.userAgent,
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

/** Text helper for tool rendering. */
function text(body) {
  return [{ type: 'text', text: body }];
}

const API_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'Whether GitHub answered with a 2xx status.' },
    status: { type: 'integer', description: 'HTTP status code.' },
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
      description: 'GitHub rate-limit headers when present.',
      properties: {
        limit: { type: 'integer' },
        remaining: { type: 'integer' },
        used: { type: 'integer' },
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
  },
  required: ['ok', 'status', 'method', 'url', 'account', 'credentialSource', 'truncated', 'data'],
};

/** Render one `github_api` result as the model-facing text. */
function renderApi(_args, value) {
  const lines = [`${value.method} ${value.url} -> ${value.status}${value.ok ? '' : ' (failed)'}`];
  lines.push(`account: ${value.account} (${value.credentialSource})`);
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

const ACCOUNTS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    accounts: {
      type: 'array',
      description: 'Every account this plugin can use; values are never included.',
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
    defaultAccount: { type: 'string' },
    envFallback: { type: 'boolean' },
    envName: { type: 'string' },
    baseUrl: { type: 'string' },
    storeAvailable: { type: 'boolean', description: 'Whether this profile has a credentials service.' },
  },
  required: ['accounts', 'defaultAccount', 'envFallback', 'envName', 'baseUrl', 'storeAvailable'],
};

function renderAccounts(_args, value) {
  const lines = [`default account: ${value.defaultAccount}`];
  lines.push(`host: ${value.baseUrl}`);
  if (value.accounts.length === 0) lines.push('no accounts');
  for (const account of value.accounts) {
    const state = account.configured ? `configured (${account.source})` : 'no token';
    lines.push(`- ${account.name}${account.isDefault ? ' [default]' : ''}: ${state}`);
  }
  if (value.envFallback) {
    lines.push(`fallback: ${value.envName} is used for the default account when no token is stored`);
  }
  if (!value.storeAvailable) lines.push('this profile has no credentials service; tokens cannot be stored');
  return text(lines.join('\n'));
}

const KEY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    account: { type: 'string' },
    configured: { type: 'boolean' },
    source: { type: 'string' },
    value: { type: 'string', description: 'The token, for action "get" only.' },
    message: { type: 'string' },
  },
  required: ['ok', 'action', 'account', 'configured'],
};

function renderKey(_args, value) {
  if (value.action === 'get') {
    if (value.ok && typeof value.value === 'string') {
      return text(`account "${value.account}" (${value.source})\n${value.value}`);
    }
    return text(`account "${value.account}" is not configured${value.message === undefined ? '' : `: ${value.message}`}`);
  }
  if (value.action === 'set') return text(`account "${value.account}" stored`);
  return text(`account "${value.account}" removed`);
}

/**
 * Register the three tools in the scope that resolved the `tools` service.
 * @param ctx - context owning `tools` and `credentials`.
 * @param config - normalized row configuration.
 */
function registerTools(ctx, config) {
  ctx.tools.register({
    name: 'github_api',
    description:
      'Call the GitHub REST API with the user\'s stored token. `path` is relative to the configured host '
      + '(for example "/repos/octocat/Hello-World/issues" or "/search/issues"), and `query`/`body` carry '
      + 'parameters and JSON. Returns the status, the parsed body (bounded), rate-limit and page numbers. '
      + 'Ask with github_accounts which credential exists before you rely on a private repository.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Path on the GitHub API host, starting with "/". Absolute URLs are refused.',
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
      required: ['path'],
    },
    output: { schema: API_OUTPUT_SCHEMA, render: renderApi },
    isConcurrencySafe(args) {
      return normalizeMethod(asObject(args).method) === 'GET';
    },
    async execute(args, exec) {
      const input = asObject(args);
      const method = normalizeMethod(input.method);
      if (method === undefined) {
        throw new Error(`github_api method must be one of ${METHODS.join(', ')}`);
      }

      const path = typeof input.path === 'string' ? input.path.trim() : '';
      if (path.length === 0) {
        throw new Error('github_api requires "path", for example "/repos/octocat/Hello-World"');
      }
      if (!path.startsWith('/') || path.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)) {
        throw new Error('github_api "path" must be a path on the configured GitHub host, starting with "/"');
      }

      let account;
      if (input.account === undefined || input.account === null || input.account === '') {
        account = config.defaultAccount;
      } else {
        account = normalizeAccount(input.account);
        if (account === undefined) {
          throw new Error('github_api "account" must be lowercase letters, digits and dashes, starting with a letter');
        }
      }

      const url = buildUrl(config, path, input.query);
      const credential = await accountToken(ctx, config, account);
      const body = input.body !== undefined && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')
        ? JSON.stringify(input.body)
        : undefined;

      const response = await githubRequest(config, {
        url,
        method,
        headers: {
          ...githubHeaders(config, credential.token),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body,
        signal: exec.signal,
      });

      const hint = response.ok ? undefined : hintFor(response.status, response.rateLimit?.remaining);
      return {
        ok: response.ok,
        status: response.status,
        method,
        url: url.toString(),
        account,
        credentialSource: credential.token === undefined ? 'unset' : credential.source,
        truncated: response.truncated,
        data: response.data,
        ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
        ...(response.pagination === undefined ? {} : { pagination: response.pagination }),
        ...(hint === undefined ? {} : { hint }),
      };
    },
  });

  ctx.tools.register({
    name: 'github_accounts',
    description:
      'List the GitHub credential accounts available to this Harness: their names, whether a token is '
      + 'configured, and where it comes from. Never returns token values. Use it to choose the `account` '
      + 'for github_api, or to tell the user which account still needs a token.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: ACCOUNTS_OUTPUT_SCHEMA, render: renderAccounts },
    isConcurrencySafe: () => true,
    async execute() {
      return {
        accounts: await listAccounts(ctx, config),
        defaultAccount: config.defaultAccount,
        envFallback: config.envFallback,
        envName: config.envName,
        baseUrl: config.baseUrl,
        storeAvailable: ctx.get('credentials') !== undefined,
      };
    },
  });

  ctx.tools.register({
    name: 'github_key',
    description:
      'Read or manage one GitHub API token by account name. action "get" returns the token itself and is '
      + (config.exposeKeys ? 'enabled here' : 'disabled by this plugin\'s configuration')
      + '; use it only when the user asks for the key or needs it for another service. '
      + 'action "set" stores a token the user supplied; action "clear" removes the stored token and falls '
      + 'back to the environment reference, if any.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'clear'],
          description: '`get` reveals the token, `set` stores one, `clear` removes the stored one.',
        },
        account: {
          type: 'string',
          description: 'Account name (lowercase, digits, dashes). Defaults to the configured default account.',
        },
        value: {
          type: 'string',
          description: 'The token to store; required for action "set" and ignored otherwise.',
        },
      },
      required: ['action'],
    },
    output: { schema: KEY_OUTPUT_SCHEMA, render: renderKey },
    async execute(args, exec) {
      const input = asObject(args);
      const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : '';
      if (action !== 'get' && action !== 'set' && action !== 'clear') {
        throw new Error('github_key "action" must be "get", "set" or "clear"');
      }
      const account = input.account === undefined || input.account === null || input.account === ''
        ? config.defaultAccount
        : normalizeAccount(input.account);
      if (account === undefined) {
        throw new Error('github_key "account" must be lowercase letters, digits and dashes, starting with a letter');
      }

      if (action === 'get') {
        if (!config.exposeKeys) {
          throw new Error(
            'github_key cannot reveal tokens: exposeKeys is false in this plugin\'s configuration. '
            + 'Use github_api so the token stays inside the Host, or ask the user to change exposeKeys.',
          );
        }
        if (exec.signal !== undefined && exec.signal.aborted) throw new Error('github_key was cancelled');
        const credential = await accountToken(ctx, config, account);
        if (credential.token === undefined) {
          return {
            ok: false,
            action,
            account,
            configured: false,
            source: credential.source,
            message: `no token is stored for "${account}" and no ${config.envName} fallback applies`,
          };
        }
        return {
          ok: true,
          action,
          account,
          configured: true,
          source: credential.source,
          value: credential.token,
        };
      }

      if (action === 'set') {
        const value = typeof input.value === 'string' ? input.value.trim() : '';
        if (value.length === 0) throw new Error('github_key action "set" requires a non-empty "value"');
        if (value.length > 4096) throw new Error('github_key "value" is longer than any GitHub token');
        await storeToken(ctx, config, account, value);
        return { ok: true, action, account, configured: true, source: 'stored' };
      }

      await removeToken(ctx, account);
      const remaining = await accountToken(ctx, config, account);
      return {
        ok: true,
        action,
        account,
        configured: remaining.token !== undefined,
        source: remaining.source,
      };
    },
  });
}

/** Whether one HTTP request may reach the token bridge. */
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

/** The bridge surface the Client page uses. Every reply is `{ ok, value }` or `{ ok: false, code, message }`. */
function createBridge(ctx, config, trust) {

  const status = async () => ({
    accounts: await listAccounts(ctx, config),
    defaultAccount: config.defaultAccount,
    envFallback: config.envFallback,
    envName: config.envName,
    exposeKeys: config.exposeKeys,
    baseUrl: config.baseUrl,
    storeAvailable: ctx.get('credentials') !== undefined,
  });

  const handlers = {
    async status() {
      return { ok: true, value: await status() };
    },

    async set(body) {
      const account = normalizeAccount(body.account ?? config.defaultAccount);
      if (account === undefined) {
        return { ok: false, code: 'invalid-account', message: 'account must be lowercase letters, digits and dashes' };
      }
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (token.length === 0) return { ok: false, code: 'empty-token', message: 'the token is empty' };
      if (token.length > 4096) return { ok: false, code: 'long-token', message: 'the token is longer than any GitHub token' };
      await storeToken(ctx, config, account, token);
      return { ok: true, value: await status() };
    },

    async clear(body) {
      const account = normalizeAccount(body.account ?? config.defaultAccount);
      if (account === undefined) {
        return { ok: false, code: 'invalid-account', message: 'account must be lowercase letters, digits and dashes' };
      }
      await removeToken(ctx, account);
      return { ok: true, value: await status() };
    },

    async verify(body) {
      const account = normalizeAccount(body.account ?? config.defaultAccount);
      if (account === undefined) {
        return { ok: false, code: 'invalid-account', message: 'account must be lowercase letters, digits and dashes' };
      }
      const credential = await accountToken(ctx, config, account);
      if (credential.token === undefined) {
        return { ok: false, code: 'no-token', message: `no token is stored for "${account}"` };
      }
      const url = buildUrl(config, '/user', undefined);
      const response = await githubRequest(config, {
        url,
        method: 'GET',
        headers: githubHeaders(config, credential.token),
      });
      if (!response.ok) {
        return {
          ok: false,
          code: `github-${response.status}`,
          message: hintFor(response.status, response.rateLimit?.remaining) ?? `GitHub answered ${response.status}`,
        };
      }
      const profile = asObject(response.data);
      return {
        ok: true,
        value: {
          account,
          source: credential.source,
          login: typeof profile.login === 'string' ? profile.login : undefined,
          name: typeof profile.name === 'string' ? profile.name : undefined,
          rateLimit: response.rateLimit,
        },
      };
    },
  };

  const routes = [
    ['/status', 'status'],
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
          message: 'the GitHub key bridge only answers same-origin requests from this machine',
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
 * Mount the tools and the bridge. Each registration is an effect owned by this
 * plugin, so unloading removes both surfaces.
 * @param ctx - the plugin context.
 * @param rawConfig - the row configuration from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  // Trusted authorities for the key bridge. The deployment's own trusted hosts
  // join this list when the Web startup facts are available; without them the
  // bridge answers loopback requests only.
  const trust = { hosts: [] };

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      registerTools(toolsCtx, config);
      return () => {};
    }, 'dsh-github: tools');
  });

  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => {
      const disposers = createBridge(serverCtx, config, trust).map((route) => serverCtx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-github: key bridge');
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
    }, 'dsh-github: bridge trust');
  });

  ctx.logger?.info?.(
    `github: base ${config.baseUrl}, default account "${config.defaultAccount}", `
    + `key reveal ${config.exposeKeys ? 'enabled' : 'disabled'}, `
    + `environment fallback ${config.envFallback ? config.envName : 'off'}`,
  );
}
