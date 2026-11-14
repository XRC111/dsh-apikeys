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
| `apikey_platforms` | List platforms and their accounts: whether a key is configured, where it comes from, and when it was last verified. Never returns values. |
| `apikey_key` | `get` (reveal one key), `set` (store a key), `clear` (remove the stored key). |
| `apikey_upload` | Send `multipart/form-data` with a file read from this machine — Hugging Face model uploads, GitHub release assets. The path must sit under `upload.roots`. |

A failed request returns as a normal result with a `hint` describing what the status usually means. **A transport failure does too** — status `0` with the reason — so a network outage is something the model can read and react to, not a broken turn. If proxy variables are set, the hint names them and the switch Node needs (see [Proxy](#proxy)).

## Optional layers

Everything here is **off by default or preserves existing behaviour**, so
upgrading changes nothing until you opt in.

| Layer | Default | What it does |
|---|---|---|
| **Encrypted vault** | off | Keys live in an AES-256-GCM envelope instead of DSH's plaintext credential file, unlocked by a master password. |
| **Audit log** | on | Hash-chained record of who touched which account. Never records a key. Viewable in Settings → API Keys. |
| **Response redaction** | on | Removes the key you used, and anything shaped like a credential, from API responses before the model sees them. |
| **Verify health** | on | Remembers the last verification per account, so the page shows a badge instead of making you click Verify again. |
| **Credential rotation** | off | Fail over to another account of the same platform on 401/403/429, with exponential backoff. |
| **Upload** | on | `apikey_upload`, bounded by `upload.roots`. |

### Encrypted vault

```sh
# The password comes from the environment or the settings page — never argv.
DSH_APIKEYS_MASTER_PASSWORD='…' dsh web
```

Turn it on with `vault.enabled: true`. On the first unlock, keys already in the
credential store are moved into the vault **and the plaintext records deleted**,
so turning the vault on is also the upgrade path — nothing needs re-entering.
`vault.migrateCredentials: false` skips the move.

While it is locked, a call that needs a key is refused rather than quietly
falling back to the plaintext store. Set `vault.failClosed: false` to get the
old fallback back.

**This is not a sandbox.** A process running as you can read the decrypted keys
while the vault is open. What it buys is that a stolen file is useless, and that
the window narrows from "always" to "while running". The full statement is in
[SECURITY.md](SECURITY.md).

### Audit log

Records `platform`, `account`, `action`, outcome and time — never a value. Each
entry carries the previous entry's hash, so editing, removing or reordering an
entry breaks the chain from that point. `Settings → API Keys → Audit log` shows
the entries and the chain verdict.

The chain proves **integrity, not authorship**: anyone who can write the file can
rebuild a consistent chain. It is evidence about mistakes, not a defence against
someone covering their tracks.

### Rotation

With `rotation.enabled: true`, the accounts of one platform form a failover
pool. An account the platform rejected enters exponential backoff and is skipped
(shown as a ⏳ badge and in the tooltip). Accounts on different platforms are
never mixed, and with rotation off an account is exactly the one you asked for.

### Health

Every `Verify` stores its timestamp, result and the identity the platform
returned. The account chip shows it, and `apikey_platforms` reports it, so an
accounts list that has not been checked still says when it last was.

## CLI

The same vault, without a running harness — useful for cron, CI, or a machine
where DSH is not up.

```sh
npx dsh-apikeys list
npx dsh-apikeys verify github
npx dsh-apikeys audit --verify
npx dsh-apikeys call github /user
npx dsh-apikeys status
```

The master password comes from `DSH_APIKEYS_MASTER_PASSWORD` or
`--password-stdin`. It is deliberately **not** accepted as an argument:
arguments land in shell history and in the process list.

## Proxy

**Node's `fetch` does not read `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` unless
the runtime is told to.** Measured on Node v24.16.0: without the flag a request
goes direct even with `HTTPS_PROXY` set; with `NODE_USE_ENV_PROXY=1` the proxy
received the `CONNECT`.

So the fix belongs at the DSH process level, not in this plugin:

```sh
NODE_USE_ENV_PROXY=1 dsh web
```

If your proxy terminates TLS with its own CA, also set `NODE_EXTRA_CA_CERTS`,
otherwise requests fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

DSH exposes no general HTTP client service to plugins, so there is nothing here
to reuse — this is why the setting is documented as a launch-environment
concern. When a call fails at the transport layer, the returned hint names any
proxy variables it found, because this failure mode is otherwise very hard to
diagnose.

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
| `vault.enabled` | `false` | Encrypt keys at rest behind a master password. |
| `vault.file` | data dir | Vault path. Empty uses `$DSH_HOME/dsh-apikeys/vault.json`. |
| `vault.passwordEnv` | `DSH_APIKEYS_MASTER_PASSWORD` | Variable holding the master password. |
| `vault.failClosed` | `true` | Refuse calls while locked, instead of falling back to the plaintext store. |
| `vault.migrateCredentials` | `true` | On unlock, move keys from the credential store into the vault and delete the plaintext records. |
| `audit.enabled` | `true` | Hash-chained record of credential operations. |
| `audit.file` | data dir | Audit path. |
| `audit.maxEntries` | `2000` | Entries to keep. |
| `redact.enabled` | `true` | Strip credential-shaped strings from responses. |
| `redact.patterns` | `[]` | Extra regexes. Empty uses the built-in issuer patterns. |
| `redact.replaceWith` | `[REDACTED]` | Replacement text. |
| `health.file` | data dir | Where verify results are remembered. |
| `rotation.enabled` | `false` | Fail over between accounts of one platform. |
| `rotation.retryOn` | `[401,403,429]` | Statuses that trigger failover. |
| `rotation.cooldownBaseMs` / `cooldownMaxMs` | `5000` / `300000` | Backoff range. |
| `rotation.maxAttempts` | `3` | Accounts tried per call. |
| `upload.enabled` | `true` | Allow `apikey_upload`. |
| `upload.roots` | `[]` | Directories a file may be read from. Empty allows the working directory and your home directory. |
| `upload.maxFileBytes` | `26214400` | Largest file sent. |

Change them in your profile's `cordis.patch.yml`:

```yaml
- id: apikeys
  config:
    exposeKeys: false
    enabledPlatforms: [github, cloudflare]
    vault:
      enabled: true
    rotation:
      enabled: true
```

## Security model

**This plugin guards against mistakes, not against a determined attacker with
access to your machine.** The full statement — construction, threat table,
per-channel leak audit, and what is explicitly not defended — is in
[SECURITY.md](SECURITY.md).

Summary:

**Defended.** Keys are never written to configuration. The model does not
receive the key: `apikey_call` attaches it inside the Host, and the request
target comes from the platform definition, so a path cannot redirect a key to
another host. Response redaction removes the key from API bodies, and the
returned URL is masked even for `query`-auth platforms — that URL was a real
leak in 1.0.x and is fixed in 1.1.0, with a regression test. With the vault on,
a stolen key file is useless without the password. With the audit log on, edits
to the record of who touched what are detectable. `apikey_upload` can only read
inside `upload.roots`.

**Not defended.** A process running as your user can read the plaintext
credential file (vault off) or this plugin's memory (vault open), and can read
the key while it is in use. Memory dumps, debuggers and physical access are out
of scope. The audit chain proves integrity, not authorship: whoever can write
the file can rebuild a consistent chain. Redaction catches known credential
shapes, not a novel format.

If a key may have leaked, revoke it at the platform — removing it from this
plugin does not un-leak it.

## Relationship to other plugins

This is **a credential proxy for outbound API calls**, and it is deliberately
narrow. It is not a general password manager and it is not a key pool for one
provider.

| If you want… | Use |
|---|---|
| To call many different APIs with your identity, without the model holding the key | **this plugin** |
| To store SSH keys, passwords, TOTP secrets and other secrets, with a vault UI | `dsh-vaultx` |
| Many keys for one LLM provider, load-balanced or rotated across them | `dsh-api-key-pool` |

The boundary in practice:

- **vs. a general vault (`dsh-vaultx`)** — this plugin does not manage TOTP,
  SSH keys, or arbitrary secrets, and its vault exists only so API keys are not
  plaintext on disk. If you need a secret store with categories and an editor,
  that is a different tool. What this one adds is the *proxy*: the key is
  attached to requests by the Host, which a password box cannot do.
- **vs. a provider key pool (`dsh-api-key-pool`)** — this plugin's rotation is a
  failure-recovery aid for outbound platform calls (401/403/429 ⇒ next account
  in backoff). It does not do load balancing, quota accounting, or weighted
  selection, and it does not know what an LLM provider is.
- **vs. DSH's own credential store** — this plugin stores into it by default, so
  the two are not alternatives. The vault is an opt-in layer *on top* of it for
  people who do not want plaintext keys on disk.

None of these are exclusive; running more than one is normal.

## How it works

```
Client page ──POST /api/dsh-apikeys/{status,set,clear,verify}──▶ Host bridge
                                                                  │
                            ┌─────────────────────────────────────┴──────────┐
                            │ vault (opt-in, encrypted)                      │
                            │ ctx.credentials records (plaintext, default)   │
                            └─────────────────────────────────────┬──────────┘
                                                                  │
model ── apikey_call / apikey_platforms / apikey_key ─────────────┘
              apikey_upload            │
                                       ├─ redaction ──▶ result
                                       └─ audit chain (hash-linked)
```

Every collaborator (`tools`, `webServer`, `credentials`, `webStartup`) is resolved through the Cordis context, so the bundle keeps loading across DSH versions that keep those seams. The one package import is `@deepseek-ai/schemastery`, because a plugin's `Config` has to be a Schema — a row without one gets no configure control on the Plugins page.

### Files

```
index.js           Host half: platform table, key resolution, four tools, the bridge
client.js          Client half: settings section + plugin row page
lib/vault.js       Envelope encryption (scrypt + AES-256-GCM)
lib/vault-store.js Vault as a key store: unlock, lock, get, set, rekey
lib/audit.js       Hash-chained audit log
lib/redact.js      Response redaction (exact key + issuer patterns)
lib/state.js       Verify results (persisted) and rotation backoff (in memory)
bin/cli.mjs        Out-of-band CLI
cordis.patch.yml   The plugin row, with the default config
locale/en.json     Plugin Manager title and description (English)
locale/zh.json     Plugin Manager title and description (中文)
icon.svg           Plugin artwork
SECURITY.md        Threat model and per-channel leak audit
dev/               Verification scripts (not published)
```

## Verification

Five suites, run in CI on Node 20/22/24.

**`dev/security-tests.mjs`** — the cryptographic and log primitives, with no
harness needed:

- Vault round-trips; a wrong password is refused; a modified body fails its
  integrity check; lowering the KDF cost breaks the authenticated header; a
  swapped DEK block is refused; a rekey keeps the payload and retires the old
  password; each seal uses a fresh salt, DEK and IV.
- Audit chain verifies when untouched, and exposes an edit, a removal and a
  reorder at the right position; a rebuilt chain still verifies, which is how
  the "integrity, not authorship" limitation is asserted rather than hidden.
- Redaction removes a known key, a foreign token shape and a JWT; ignores very
  short literals; and a global pattern does not skip the second call.
- Backoff doubles, caps, and is cleared by a success.

**`dev/integration-tests.mjs`** — the layers wired into the real plugin:

- The vault holds the key, the credential store stays empty, and the file
  contains no plaintext.
- A locked vault refuses the call and does **not** fall through to a plaintext
  record; `failClosed: false` deliberately does.
- Migration moves keys from the credential store (all platforms, named accounts
  included) and deletes the plaintext copies; the earlier plugin's
  `dsh-github/<account>` records are left in place and adopted.
- Redaction removes the key from a response body and from a `query`-auth URL,
  even with redaction disabled.
- Audit records set/call/clear without recording a value, and an edited entry is
  reported as broken through the endpoint.
- Rotation fails over on 401, names the account that answered, skips a cooling
  account on the next call; rotation off makes exactly one attempt.
- Upload sends real multipart `FormData`, refuses a path outside `upload.roots`,
  refuses a file over the cap, and can be turned off.

**`dev/host-smoke.mjs`** — every registration checked with the runtime's own
validators: `assertSupportedJsonSchema` for each `parameters` and
`output.schema`, `validateJsonSchemaValue` for model arguments, plus the Config
schema defaults, all five auth kinds, the refusal paths, and the bridge's
cross-site / foreign-origin / non-POST guards.

**`dev/client-smoke.mjs`** — the browser bundle materialized through the real
`__ModuleLoader__` contract and both slot entries rendered in `zh` and `en`.

**`dev/verify-endpoints.mjs`** — each built-in platform's verify path probed
against the live API: a real endpoint answers 401/403/400 for a bad key, and a
wrong path answers 404.
- The migration path: a key under the earlier `dsh-github/<account>` layout is adopted once and never overwrites a newer one.
- Every bridge route plus every refusal path (cross-site, foreign origin, non-POST, unknown platform, invalid account, empty key).
- The Client bundle materialized through the real `__ModuleLoader__` contract, with both slot entries rendered in `zh` and `en`, including the unreachable-Host and no-platforms states.

Run them yourself:

```bash
# No install and no harness needed:
node dev/security-tests.mjs

node dev/client-smoke.mjs

# These validate against an installed DSH:
DSH_TOOLS_PATH=/path/to/node_modules/@deepseek-ai/dsh-tools/lib/index.js node dev/host-smoke.mjs
DSH_TOOLS_PATH=/path/to/node_modules/@deepseek-ai/dsh-tools/lib/index.js node dev/integration-tests.mjs
DSH_TOOLS_PATH=/path/to/node_modules/@deepseek-ai/dsh-tools/lib/index.js node dev/verify-endpoints.mjs
```

`host-smoke` and `integration-tests` link the harness copy of
`@deepseek-ai/schemastery` before importing the plugin — a bare specifier can
only be resolved by Node's own loader — and remove the link afterwards, so a
fresh clone needs no install.

`verify-endpoints.mjs` makes real network calls. Docker Hub and Hugging Face
were unreachable from the machine this was developed on; the script reports that
as a network result rather than a failure, and their endpoint paths are
unverified from here.

## Limitations

- Records are stored per profile. Two profiles configured here do not share accounts.
- The page renders in `settings.section` and `plugins.row.config`; a DSH version that renames either slot leaves the page unreachable until updated, though the tools keep working.
- Only the default account of each platform inherits its environment variable. A named account is always its own record.
- `apikey_call` speaks HTTP and JSON. Use `apikey_upload` for multipart.
- `apikey_upload` does not resolve symlinks before checking `upload.roots`, so a symlink inside an allowed root can point outside it. See [SECURITY.md](SECURITY.md) §7.
- The vault protects a file at rest, not a running process. See [SECURITY.md](SECURITY.md) §4.
- The audit chain proves integrity, not authorship. See [SECURITY.md](SECURITY.md) §5.
- The CLI reads the vault directly; with the vault disabled it has nothing to read, because DSH's credential store has no out-of-band API.

## License

MIT — see [LICENSE](LICENSE).

MIT — see [LICENSE](LICENSE).
