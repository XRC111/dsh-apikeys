# dsh-apikeys-plugin

One credential store for many API platforms, for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — plus the tools that let the model use those keys.

Store a key once. The model calls the platform's API as you, and never sees the key unless you explicitly ask for it.

## Why

The model already knows these APIs. What it lacks is your credential, a safe place to keep it, and a way to use it that cannot leak it somewhere else.

- **Keys never enter configuration or the conversation.** They live in DSH's credential store as `dsh-apikeys/<platform>-<account>` records — not in `cordis.patch.yml`, not in a settings file, not in the session log.
- **The model gets tools, not keys.** It calls `apikey_call`, and the Host attaches the credential. Reading the raw value is a separate, configurable action.
- **A key can only reach its own platform.** `apikey_call` takes a *path*, never a URL: the host comes from the platform definition, so a GitHub token cannot be sent to `evil.example`.
- **Multiple accounts per platform.** Work and personal keys coexist; a named account never silently borrows another account's key.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-apikeys-plugin
```

Or from the Web UI: **Plugins → Add → `dsh-apikeys-plugin`**. Restart DSH afterwards if your profile runs without HMR.

Then open **Settings → API Keys**, pick a platform, paste a key, and press **Verify**.

## Platforms

| id | Verification endpoint | Environment fallback |
|---|---|---|
| `github` | `GET /user` → login | `GITHUB_TOKEN` |
| `cloudflare` | `GET /user/tokens/verify` → status | `CLOUDFLARE_API_TOKEN` |
| `vercel` | `GET /v2/user` → username | `VERCEL_TOKEN` |
| `npm` | `GET /-/whoami` → username | `NPM_TOKEN` |
| `dockerhub` | `GET /user` → username | `DOCKERHUB_TOKEN` |
| `huggingface` | `GET /whoami-v2` → name | `HF_TOKEN` |

**Verify does a real request.** It tells you whether the key *works*, not merely whether it saved — and it reports the identity the platform returns, so you can confirm you stored the account you meant to.

### Adding your own platform

Any HTTP API works. Set the base URL, the auth shape, and (optionally) an endpoint the page can verify against:

```yaml
customPlatforms:
  - id: acme
    label: Acme API
    baseUrl: https://api.acme.example/v1
    envName: ACME_API_KEY
    docs: https://acme.example/keys
    verify:
      path: /me
      identity: data.login      # dotted path into the JSON body
    auth:
      kind: bearer              # bearer | header | x-api-key | basic | query
      scheme: Bearer
    headers: {}                 # extra static request headers
```

Without a `verify` block the platform still works with `apikey_call`; the page just cannot test the key for you. A custom row missing a usable `baseUrl`, or needing a header name it did not give, is skipped rather than breaking the page.

## Tools

| Tool | Purpose |
|---|---|
| `apikey_call` | Call one platform's API. `platform` picks the service (which fixes the host), `path` is relative to its base, `query`/`body` carry parameters and JSON. Returns status, parsed body (bounded), rate limit and page numbers. |
| `apikey_platforms` | List platforms and their accounts: whether a key is configured, and where it comes from. Never returns values. |
| `apikey_key` | `get` (reveal one key), `set` (store a key), `clear` (remove the stored key). |

A failed request returns as a normal result with a `hint` describing what the status usually means. **A transport failure does too** — status `0` with the reason — so a network outage is something the model can read and react to, not a broken turn.

## Configuration

All fields are optional; the shipped patch sets the defaults.

| Field | Default | Meaning |
|---|---|---|
| `defaultPlatform` | `github` | Platform used when a call names none. |
| `defaultAccount` | `default` | Account used when a call names none. |
| `enabledPlatforms` | all built-ins | Which built-in platforms to expose. |
| `accounts` | `[]` | Account names to keep visible before they hold a key. |
| `customPlatforms` | `[]` | Your own platform definitions. |
| `exposeKeys` | `true` | Whether `apikey_key get` may return a key value. Set `false` to keep keys inside the Host. |
| `envFallback` | `true` | Fall back to each platform's environment variable for its default account. |
| `maxResponseChars` | `20000` | Response body cap per call (2000–400000). |
| `requestTimeoutMs` | `30000` | Per-request timeout (1000–180000). |
| `userAgent` | `dsh-apikeys` | `User-Agent` header. |
| `migrateGitHub` | `true` | Adopt keys the earlier github-only plugin left under `dsh-github/<account>`. |

Change them in your profile's `cordis.patch.yml`:

```yaml
- id: apikeys
  config:
    exposeKeys: false
    enabledPlatforms: [github, cloudflare]
```

## Security model

An honest summary of what this does and does not protect against.

**Protected:** keys are not written to configuration; they are not echoed into tool results by default; and `apikey_call` cannot send a key to another host, because the host comes from the platform definition and the path is refused if it is absolute or tries to leave the origin. The settings bridge refuses cross-site requests, foreign origins, and non-POST methods, and serves loopback only unless the deployment names trusted hosts.

**Not protected:** DSH's local credential file is readable by your OS user, and agent tool processes run as that same user. A key stored here cannot be hidden from a process running as you. Treat `exposeKeys: false` as a guardrail against accidental disclosure, not as a sandbox.

If a key may have leaked, revoke it at the platform — removing it from this plugin does not un-leak it.

## How it works

```
Client page ──POST /api/dsh-apikeys/{status,set,clear,verify}──▶ Host bridge
                                                                  │
                                       ctx.credentials records (dsh-apikeys/<platform>-<account>)
                                                                  │
model ── apikey_call / apikey_platforms / apikey_key ─────────────┘
```

The Host half imports nothing. Every collaborator (`tools`, `webServer`, `credentials`, `webStartup`) is resolved through the Cordis context, so the bundle keeps loading across DSH versions that keep those seams.

### Files

```
index.js           Host half: platform table, credential helpers, three tools, the bridge
client.js          Client half: settings section + plugin row page
cordis.patch.yml   The plugin row, with the default config
locale/en.json     Plugin Manager title and description (English)
locale/zh.json     Plugin Manager title and description (中文)
icon.svg           Plugin artwork
dev/               Verification scripts (not published)
```

## Verification

Checked against every DSH mechanism this depends on, using the runtime's own validators:

- Every registered `parameters` and `output.schema` accepted by `assertSupportedJsonSchema`, and model arguments checked through `validateJsonSchemaValue`.
- All five auth kinds driven end to end: bearer, custom header, `x-api-key`, basic (username:key), and query-string.
- Each built-in platform's verify path probed against the live API — a real endpoint answers 401/403/400 for a bad key, and a wrong path answers 404. None return 404.
- A transport failure returning status `0` with a hint instead of throwing.
- Key lifecycle against a stubbed credential store: store, resolve, precedence over the environment fallback, named accounts not inheriting it, clear.
- The migration path: a key under the earlier `dsh-github/<account>` layout is adopted once and never overwrites a newer one.
- Every bridge route plus every refusal path (cross-site, foreign origin, non-POST, unknown platform, invalid account, empty key).
- The Client bundle materialized through the real `__ModuleLoader__` contract, with both slot entries rendered in `zh` and `en`, including the unreachable-Host and no-platforms states.

Run them yourself:

```bash
node dev/client-smoke.mjs

# host-smoke and verify-endpoints validate against an installed DSH:
DSH_TOOLS_PATH=/path/to/node_modules/@deepseek-ai/dsh-tools/lib/index.js node dev/host-smoke.mjs
DSH_TOOLS_PATH=/path/to/node_modules/@deepseek-ai/dsh-tools/lib/index.js node dev/verify-endpoints.mjs
```

`verify-endpoints.mjs` makes real network calls. Docker Hub and Hugging Face were unreachable from the machine this was developed on; the script reports that as a network result rather than a failure, and their endpoint paths are unverified from here.

## Limitations

- Records are stored per profile. Two profiles configured here do not share accounts.
- The page renders in `settings.section` and `plugins.row.config`; a DSH version that renames either slot leaves the page unreachable until updated, though the tools keep working.
- Only the default account of each platform inherits its environment variable. A named account is always its own record.
- `apikey_call` speaks HTTP and JSON. Multipart uploads are not modelled — the body is serialized as JSON.

## License

MIT — see [LICENSE](LICENSE).
