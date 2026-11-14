#!/usr/bin/env node
/**
 * Out-of-band CLI for `dsh-apikeys-plugin`.
 *
 * Some jobs do not belong in a chat: checking every stored key from a cron job,
 * listing what exists on a machine where the harness is not running, reading the
 * audit trail while debugging. This talks to the same vault file the plugin
 * uses, so it needs no running Host and no credential service.
 *
 *   npx dsh-apikeys list
 *   npx dsh-apikeys verify <platform> [--account <name>]
 *   npx dsh-apikeys audit [--verify] [--limit 50]
 *   npx dsh-apikeys call <platform> <path> [-X METHOD]
 *
 * The master password comes from `DSH_APIKEYS_MASTER_PASSWORD` or `--password-stdin`,
 * never from an argument (arguments land in shell history and process listings).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAuditLog } from '../lib/audit.js';
import { createVaultStore } from '../lib/vault-store.js';
import { BUILTIN_PLATFORMS, readConfig, resolvePlatforms } from '../index.js';

const USAGE = `dsh-apikeys — manage the keys dsh-apikeys-plugin stores

Usage:
  dsh-apikeys list                            Show every account and whether it has a key
  dsh-apikeys verify <platform> [--account n] Ask the platform whether the key works
  dsh-apikeys audit [--verify] [--limit n]    Show the audit trail and check its chain
  dsh-apikeys call <platform> <path> [-X M]   Call a platform endpoint directly
  dsh-apikeys status                          Show the effective configuration

Options:
  --account <name>    Account to act on (default: the configured default account)
  --config <file>     JSON config file overriding the built-in defaults
  --vault <file>      Vault file path (default: $DSH_HOME/dsh-apikeys/vault.json)
  --password-stdin    Read the master password from standard input
  --json              Print machine-readable JSON
  -X, --method <m>    HTTP method for "call" (default: GET)

Environment:
  DSH_APIKEYS_MASTER_PASSWORD   Master password for an encrypted vault
  DSH_HOME                      Base directory for the plugin's files

The master password is never accepted as an argument: arguments show up in shell
history and in the process list.`;

/** Minimal argument parsing; no dependency, and unknown flags are an error. */
function parseArgs(argv) {
  const options = {
    command: argv[0], positionals: [], account: undefined, config: undefined,
    vault: undefined, passwordStdin: false, json: false, method: 'GET',
    verify: false, limit: 50,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[++index];
    if (flag === '--account') options.account = next();
    else if (flag === '--config') options.config = next();
    else if (flag === '--vault') options.vault = next();
    else if (flag === '--password-stdin') options.passwordStdin = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--verify') options.verify = true;
    else if (flag === '--limit') options.limit = Number(next());
    else if (flag === '-X' || flag === '--method') options.method = String(next() ?? 'GET').toUpperCase();
    else if (flag === '--help' || flag === '-h') options.command = 'help';
    else if (flag.startsWith('-')) throw new Error(`unknown option ${flag}`);
    else options.positionals.push(flag);
  }
  return options;
}

/** Read the master password without ever taking it from argv. */
function readPassword(options) {
  const fromEnvironment = process.env.DSH_APIKEYS_MASTER_PASSWORD;
  if (typeof fromEnvironment === 'string' && fromEnvironment.length > 0) return fromEnvironment;
  if (options.passwordStdin) {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.replace(/\r?\n$/u, '');
  }
  return undefined;
}

/** Load the effective config, optionally from a JSON file. */
function loadConfig(options) {
  let raw = {};
  if (options.config !== undefined) {
    raw = JSON.parse(fs.readFileSync(path.resolve(options.config), 'utf8'));
  }
  const config = readConfig(raw);
  if (options.vault !== undefined) config.vault = { ...config.vault, file: path.resolve(options.vault) };
  return config;
}

/** Print a table. */
function table(rows, columns) {
  const widths = columns.map((column) => Math.max(
    column.label.length,
    ...rows.map((row) => String(row[column.key] ?? '').length),
  ));
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ').trimEnd();
  console.log(line(columns.map((column) => column.label)));
  console.log(line(widths.map((width) => '─'.repeat(width))));
  for (const row of rows) console.log(line(columns.map((column) => row[column.key] ?? '')));
}

function out(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(value);
}

/** Build one request the way the plugin would, for `verify` and `call`. */
function buildHeaders(platform, key, userAgent) {
  const headers = { 'user-agent': userAgent, ...(platform.headers ?? {}) };
  if (key === undefined) return headers;
  const auth = platform.auth ?? { kind: 'bearer' };
  const scheme = auth.scheme ?? 'Bearer';
  switch (auth.kind) {
    case 'bearer': headers.authorization = `${scheme} ${key}`; break;
    case 'header': headers[auth.header] = key; break;
    case 'x-api-key': headers[auth.header] = key; break;
    case 'basic':
      headers.authorization = `Basic ${Buffer.from(`${auth.username ?? ''}:${key}`, 'utf8').toString('base64')}`;
      break;
    default: headers.authorization = `${scheme} ${key}`;
  }
  return headers;
}

/** Resolve the URL from the platform base plus a relative path. */
function buildUrl(platform, relative, key) {
  const base = new URL(platform.baseUrl);
  const prefix = base.pathname.replace(/\/+$/u, '');
  const url = new URL(`${prefix}${relative}`, base.origin);
  if (url.origin !== base.origin) throw new Error(`${platform.id} refused to leave its configured host`);
  const auth = platform.auth ?? { kind: 'bearer' };
  if (auth.kind === 'query' && key !== undefined) url.searchParams.set(auth.queryParam ?? 'api_key', key);
  return url;
}

/**
 * A URL safe to print.
 *
 * The `query` auth kind carries the credential in the URL, and this output ends
 * up in terminals, logs and pasted issue reports — so the key is masked here
 * unconditionally.
 */
function describeUrl(url, key) {
  const rendered = url.toString();
  if (typeof key !== 'string' || key.length === 0) return rendered;
  return rendered.split(key).join('[REDACTED]').split(encodeURIComponent(key)).join('[REDACTED]');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === undefined || options.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (options.command === 'version' || options.command === '--version') {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }

  const config = loadConfig(options);
  const platforms = resolvePlatforms(config);
  const platformIds = [...platforms.keys()];

  if (options.command === 'status') {
    const summary = {
      platforms: platformIds,
      defaultPlatform: config.defaultPlatform,
      defaultAccount: config.defaultAccount,
      exposeKeys: config.exposeKeys,
      vault: { enabled: config.vault.enabled, file: config.vault.file, failClosed: config.vault.failClosed },
      audit: { enabled: config.audit.enabled, file: config.audit.file },
      redact: { enabled: config.redact.enabled },
      rotation: { enabled: config.rotation.enabled, retryOn: config.rotation.retryOn },
      dataDir: process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'dsh-apikeys') : path.join(os.homedir(), '.dsh', 'dsh-apikeys'),
    };
    if (options.json) { out(summary, true); return 0; }
    console.log(`platforms        ${summary.platforms.join(', ')}`);
    console.log(`default          ${summary.defaultPlatform}/${summary.defaultAccount}`);
    console.log(`vault            ${summary.vault.enabled ? summary.vault.file : 'off'}`);
    console.log(`audit            ${summary.audit.enabled ? summary.audit.file : 'off'}`);
    console.log(`redaction        ${summary.redact.enabled ? 'on' : 'off'}`);
    console.log(`rotation         ${summary.rotation.enabled ? 'on' : 'off'}`);
    console.log(`data directory   ${summary.dataDir}`);
    return 0;
  }

  // Everything below needs the vault.
  const vault = createVaultStore({ file: config.vault.file, enabled: true });
  const password = readPassword(options);
  if (!vault.exists() && options.command !== 'list') {
    console.error(`no vault at ${config.vault.file}`);
    console.error('The plugin stores keys in the DSH credential store until vault.enabled is turned on.');
    console.error('Turn it on in Settings → API Keys (and set DSH_APIKEYS_MASTER_PASSWORD), then run this again.');
    return 2;
  }
  const unlocked = vault.unlock(password);
  if (!unlocked.ok && vault.exists()) {
    console.error(`cannot open the vault: ${unlocked.reason}`);
    console.error('Set DSH_APIKEYS_MASTER_PASSWORD, or pass --password-stdin.');
    return 2;
  }

  if (options.command === 'list') {
    const stored = new Map(vault.list().map((entry) => [`${entry.platform}-${entry.account}`, entry]));
    const rows = [];
    for (const platform of platforms.values()) {
      const accounts = new Set([config.defaultAccount]);
      for (const entry of vault.list()) {
        if (entry.platform === platform.id) accounts.add(entry.account);
      }
      for (const account of [...accounts].sort()) {
        const entry = stored.get(`${platform.id}-${account}`);
        rows.push({
          platform: platform.id,
          account,
          key: entry === undefined ? 'no' : 'yes',
          updated: entry?.updatedAt ?? '',
        });
      }
    }
    if (options.json) { out(rows, true); return 0; }
    table(rows, [
      { key: 'platform', label: 'PLATFORM' },
      { key: 'account', label: 'ACCOUNT' },
      { key: 'key', label: 'KEY' },
      { key: 'updated', label: 'UPDATED' },
    ]);
    return 0;
  }

  if (options.command === 'audit') {
    if (!config.audit.enabled) { console.error('the audit log is turned off'); return 0; }
    const log = createAuditLog({ file: config.audit.file, maxEntries: config.audit.maxEntries });
    const chain = log.verify();
    if (options.json) {
      out({ chain, entries: log.list(options.limit) }, true);
      return chain.ok ? 0 : 1;
    }
    console.log(chain.ok ? `chain intact (${chain.entries} entries)` : `CHAIN BROKEN at entry ${chain.brokenAt}: ${chain.reason}`);
    console.log('');
    table(log.list(options.limit), [
      { key: 'seq', label: '#' },
      { key: 'at', label: 'WHEN' },
      { key: 'actor', label: 'WHO' },
      { key: 'action', label: 'WHAT' },
      { key: 'platform', label: 'PLATFORM' },
      { key: 'account', label: 'ACCOUNT' },
    ]);
    return chain.ok ? 0 : 1;
  }

  const platformId = options.positionals[1];
  const platform = platformId === undefined ? undefined : platforms.get(platformId);
  if (platform === undefined) {
    console.error(`unknown platform "${platformId ?? ''}"; one of: ${platformIds.join(', ')}`);
    return 2;
  }
  const account = options.account ?? config.defaultAccount;
  const key = vault.get(platform.id, account);
  if (key === undefined) {
    console.error(`no key for ${platform.id}/${account} in the vault`);
    return 2;
  }

  if (options.command === 'verify') {
    if (platform.verify === undefined) {
      console.error(`${platform.id} declares no verification endpoint; use "call" instead`);
      return 2;
    }
    const url = buildUrl(platform, platform.verify.path, key);
    let response;
    try {
      response = await fetch(url, { headers: buildHeaders(platform, key, config.userAgent) });
    } catch (error) {
      console.error(`request failed: ${error.cause?.code ?? error.message}`);
      return 1;
    }
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch { data = body; }
    const identity = platform.verify.identity === undefined
      ? undefined
      : platform.verify.identity.split('.').reduce((cursor, segment) => (
        cursor !== null && typeof cursor === 'object' ? cursor[segment] : undefined
      ), data);
    if (options.json) {
      out({ platform: platform.id, account, status: response.status, ok: response.ok, identity }, true);
      return response.ok ? 0 : 1;
    }
    if (response.ok) {
      console.log(`${platform.id}/${account}: OK (${response.status})${identity === undefined ? '' : ` — ${identity}`}`);
      return 0;
    }
    console.log(`${platform.id}/${account}: FAILED (${response.status})`);
    console.log(typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400));
    return 1;
  }

  if (options.command === 'call') {
    const relative = options.positionals[2];
    if (typeof relative !== 'string' || !relative.startsWith('/')) {
      console.error('call needs a path starting with "/"');
      return 2;
    }
    const url = buildUrl(platform, relative, key);
    let response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers: buildHeaders(platform, key, config.userAgent),
      });
    } catch (error) {
      console.error(`request failed: ${error.cause?.code ?? error.message}`);
      return 1;
    }
    const body = await response.text();
    if (options.json) {
      out({ platform: platform.id, method: options.method, url: describeUrl(url, key), status: response.status, ok: response.ok, body }, true);
      return response.ok ? 0 : 1;
    }
    console.log(`${options.method} ${describeUrl(url, key)} -> ${response.status}`);
    console.log(body.slice(0, config.maxResponseChars));
    return response.ok ? 0 : 1;
  }

  console.error(`unknown command "${options.command}"`);
  console.error(`run "dsh-apikeys help" for usage`);
  return 2;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
