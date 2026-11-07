# dsh-github-plugin

GitHub API tokens for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), plus the tools that let the model use them.

Store your GitHub personal access token once. The model then calls the GitHub REST API as you —
without ever seeing the token unless you explicitly ask for it.

## Why

The model already knows the GitHub API. What it lacks is your credential and a safe place to keep it.
This plugin supplies both:

- **The token never enters configuration or the conversation.** It lives in DSH's credential store
  as a `dsh-github/<account>` record — not in `cordis.patch.yml`, not in a settings file, not in the
  session log.
- **The model gets tools, not a token.** It calls `github_api` and the Host attaches the credential.
  Reading the raw value is a separate, configurable action.
- **Multiple accounts.** Work and personal tokens coexist; a named account never silently borrows
  another account's token.

## Install

```bash
dsh plugin --profile <your-profile> install dsh-github-plugin
```

Or from the Web UI: **Plugins → Add → `dsh-github-plugin`**.

Restart DSH afterwards if your profile runs without HMR.

Then open **Settings → GitHub**, paste a token, and press **Verify**.

### Getting a token

Create one at <https://github.com/settings/tokens>.

- **Classic token** — the `repo` scope for private repositories, plus `workflow` to touch workflow files.
- **Fine-grained token** — select only the repositories and permissions you need.

## Tools

| Tool | Purpose |
|---|---|
| `github_api` | Call any GitHub REST endpoint. `path` is relative to the configured host; `query` and `body` carry parameters and JSON. Returns status, parsed body (bounded), rate limit, and page numbers. |
| `github_accounts` | List every account: name, whether a token is configured, where it comes from. Never returns values. |
| `github_key` | `get` (reveal one token), `set` (store a token), `clear` (remove the stored token). |

`github_api` refuses absolute URLs, so a token can only ever reach the configured host. A failed
request returns as a normal result with a `hint` describing what the status usually means — it does
not throw and does not end the turn.

## Web surface

One page, two seats:

- **Settings → GitHub** — a settings section of its own.
- **Plugins → dsh-github-plugin → Configure** — the row configuration page.

Both drive the same-origin bridge at `/api/dsh-github` (`status`, `set`, `clear`, `verify`).
The bridge refuses cross-site requests, foreign origins, and non-POST methods, and serves loopback
only unless the deployment names trusted hosts.

## Configuration

All fields are optional; the shipped patch sets the defaults.

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://api.github.com` | API host. GitHub Enterprise Server works too (`https://ghe.example.com/api/v3`). |
| `defaultAccount` | `default` | Account used when a tool call names none. |
| `exposeKeys` | `true` | Whether `github_key get` may return a token value. Set `false` to keep tokens inside the Host. |
| `envFallback` | `true` | Fall back to `envName` for the default account while no token is stored. |
| `envName` | `GITHUB_TOKEN` | The environment reference that fallback reads. |
| `maxResponseChars` | `20000` | Response body cap per call (2000–400000). |
| `requestTimeoutMs` | `30000` | Per-request timeout (1000–180000). |
| `apiVersion` | `2022-11-28` | `X-GitHub-Api-Version` header. |
| `userAgent` | `dsh-github` | `User-Agent` header. |

Change them in your profile's `cordis.patch.yml`:

```yaml
- id: github-tools
  config:
    exposeKeys: false
    maxResponseChars: 40000
```

## Security model

An honest summary of what this does and does not protect against.

**Protected:** the token is not written to configuration, is not echoed into tool results by default,
and cannot be exfiltrated to another host through `github_api` because absolute URLs are refused.

**Not protected:** DSH's local credential file is readable by your OS user, and agent tool processes
run as that same user. A token stored here cannot be hidden from a process running as you. Treat
`exposeKeys: false` as a guardrail against accidental disclosure, not as a sandbox.

If a token may have leaked, revoke it at <https://github.com/settings/tokens> — removing it from this
plugin does not un-leak it.

## How it works

```
Client page ──POST /api/dsh-github/{status,set,clear,verify}──▶ Host bridge
                                                                  │
                                            ctx.credentials records (dsh-github/<account>)
                                                                  │
model ── github_api / github_accounts / github_key ───────────────┘
```

The Host half imports nothing. Every collaborator (`tools`, `webServer`, `credentials`,
`webStartup`) is resolved through the Cordis context, so the bundle keeps loading across DSH
versions that keep those seams.

### Files

```
index.js           Host half: credential store helpers, three tools, the bridge
client.js          Client half: settings section + plugin row page
cordis.patch.yml   The plugin row, with the default config
locale/en.json     Plugin Manager title and description (English)
locale/zh.json     Plugin Manager title and description (中文)
icon.svg           Plugin artwork
dev/               Verification scripts (not published)
```

## Verification

Checked against every DSH mechanism this depends on, using the runtime's own validators:

- Every registered `parameters` and `output.schema` accepted by `assertSupportedJsonSchema`, and model
  arguments checked through `validateJsonSchemaValue` (missing required, wrong type, unknown enum,
  undeclared key).
- `github_api` against the live GitHub API — `GET /repos/nodejs/node` → 200, parsed body, rate-limit
  headers, and an authenticated `GET /user`.
- Token lifecycle against a stubbed credential store: store, resolve, precedence over the environment
  fallback, named accounts not inheriting it, clear.
- Every bridge route plus every refusal path (cross-site, foreign origin, non-POST, invalid account,
  empty token).
- The Client bundle materialized through the real `__ModuleLoader__` contract, and both slot entries
  rendered in `zh` and `en`, including the unreachable-Host and unconfigured-account states.

Run them yourself:

```bash
# client-smoke and icon-check need nothing but Node.
node dev/client-smoke.mjs
node dev/icon-check.mjs

# host-smoke and schema-check validate against the runtime's own schemas,
# so they need an installed DSH:
DSH_RUNTIME_DIR=/path/to/dsh-runtime node dev/host-smoke.mjs
DSH_TOOLS_PATH=/path/to/node_modules/@deepseek-ai/dsh-tools/lib/index.js node dev/schema-check.mjs
```

`DSH_RUNTIME_DIR` is the directory holding the runtime's `node_modules`; the Desktop app keeps
it under its own resources directory. If neither variable is set, the scripts look in
`$DSH_HOME/profiles/*/node_modules` before giving up — and they fail loudly rather than
skipping a check.

## Limitations

- Records are stored per profile. Two profiles configured here do not share accounts.
- The page renders in `settings.section` and `plugins.row.config`; a DSH version that renames either
  slot leaves the page unreachable until updated, though the tools keep working.
- No Git LFS, GraphQL, or webhook handling — `github_api` speaks REST. GraphQL is reachable via
  `POST /graphql` with `github_api` if you need it.

## License

MIT — see [LICENSE](LICENSE).
