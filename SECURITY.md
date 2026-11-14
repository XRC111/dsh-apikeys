# Security model

This document states what `dsh-apikeys-plugin` defends against, how, and what it
does not defend against. It is written to be checkable against the code: every
claim below names the mechanism that implements it.

**The short version: this plugin guards against mistakes, not against a
determined attacker with access to your machine.**

---

## 1. Threat model

### Defended

| Threat | Mechanism |
|---|---|
| A key ending up in a session transcript by accident | The model never receives the key; `apikey_call` attaches it inside the Host |
| A key sent to an attacker-controlled host | The request target host comes from the platform definition, and the tool takes a path, not a URL |
| A key echoed back by an API in an error body | Response redaction, including an exact-match pass over the key actually used |
| A key leaking through the URL of a `query`-auth platform | The returned URL is masked unconditionally |
| Someone reading the stored keys off disk | The optional encrypted vault |
| Silent modification of the record of who touched which key | The hash-chained audit log |
| The model reading arbitrary local files and uploading them | `upload.roots`, a filesystem allowlist |
| Reading a key when the user has not asked for it | `exposeKeys: false` |

### Not defended

| Threat | Why not |
|---|---|
| A malicious process running as your user | It can read DSH's credential file, and it can read this plugin's memory once the vault is unlocked |
| A memory dump or debugger | The decrypted keys exist in this process's heap while the vault is open |
| Physical access to an unlocked machine | Same as above, plus filesystem access |
| A compromised DSH Host | The plugin runs inside it; a compromised Host can do anything the plugin can |
| Someone rewriting the entire audit chain | The chain has no external anchor; see §5 |
| A key you paste into the chat yourself | Nothing here can help with that |

DSH's local credential file is readable by your OS user, and agent tool
processes run as that user. A key stored here cannot be hidden from a process
running as you. `exposeKeys: false` is a guardrail against accidental
disclosure, not a sandbox.

---

## 2. The Host lock

The claim is: **a credential can only be sent to the host its platform fixes.**

### How a request is addressed

`apikey_call` takes `path`, never a URL. Three checks apply, in order:

1. The path must start with `/`, must not start with `//`, and must not match
   `/^[A-Za-z][A-Za-z0-9+.-]*:/`. This rejects absolute URLs (`https://…`),
   protocol-relative URLs (`//evil.example/…`), and any `scheme:` prefix.
2. `buildUrl` resolves the path against the platform's `baseUrl` **origin** and
   then asserts `url.origin === base.origin`. If resolution ever produced a
   different origin, the call is refused with
   `"<platform> refused to leave its configured host"`.
3. The request uses that URL. There is no code path that takes a URL from the
   caller.

### Path traversal

`..` segments are resolved by `URL` before the origin check, and resolution
stays inside the origin: `/../etc` becomes `/etc` **on the platform's host**.
That is a path on somebody else's API, not a host escape — the credential still
only goes to the platform's own server. Traversal within a platform's own API
surface is not a boundary violation.

Percent-encoded traversal (`%2e%2e`) is **not** decoded during resolution, so it
survives into the request path verbatim. A server that decodes it may traverse
its own routes; the host lock is unaffected.

### Where the host comes from

- **Built-in platforms**: a literal in `BUILTIN_PLATFORMS` in `index.js`. Set at
  build time; no configuration changes it.
- **Custom platforms**: `baseUrl` from the plugin configuration. Whoever can
  edit that configuration can point a platform anywhere — but they can already
  do anything else on the machine, so this is not an escalation.

### Redirects

`fetch` is called with `redirect: 'follow'`. **A redirect can carry a request to
another host, and the credential is attached to the first request only** — the
`Authorization` header is not re-sent by the browser/undici redirect machinery
across origins, but the initial request did reach the platform's own host, which
is what the lock protects. A platform that redirects to an attacker therefore
does not leak the header to the attacker. A `query`-auth credential, however,
**is** in the URL and would travel with a redirect to any host the platform
names. Treat `query` auth as weaker for this reason; it exists because some APIs
require it.

---

## 3. `exposeKeys: false`

With `exposeKeys: false`, `apikey_key get` throws before reading anything. The
question this section answers: **can the key still reach the model through some
other channel?**

Channels audited:

| Channel | Leak? | Why |
|---|---|---|
| `apikey_call` result body | No | The key is never placed in the body; response redaction is a second layer |
| `apikey_call` result URL | **No** (after 1.1.0) | `describeUrl` masks the key unconditionally — see below |
| `apikey_platforms` | No | Returns `configured: true/false` and a source label, never a value |
| `apikey_key` `get` | No | Refused outright when `exposeKeys` is false |
| Error messages | No | The refusal text names the setting, not the key; transport errors carry a code, not a value |
| Audit log | No | Entries record `platform`, `account`, `action` and outcome — never a value |
| Health records | No | They store a timestamp, a status and the identity string the platform returned |
| The bridge (`/api/dsh-apikeys/*`) | No | No route returns a key value; `set` accepts one and answers with status only |
| The vault file | No | Encrypted; the plaintext is not present anywhere in the envelope |
| The credential file (vault off) | **Yes** | It is plaintext on disk by design at this layer — this is exactly what the vault exists to fix |

The URL channel was a real defect, found while writing this document: with
`auth.kind: 'query'`, `applyQueryAuth` writes the key into `url.searchParams`,
and the result carried `url: url.toString()` back to the model — which would
have revealed the key despite `exposeKeys: false`. It is fixed in 1.1.0 and
covered by a regression test (`dev/integration-tests.mjs`, section
`query auth`), including the case where redaction is turned off: masking the URL
is not a setting.

---

## 4. The encrypted vault

Off by default. When enabled, keys live in an AES-256-GCM envelope instead of
DSH's plaintext credential file.

### Construction

```
password ──scrypt(N=2^15, r=8, p=1, salt=16B)──▶ KEK (32B)
                                                   │
                                    AES-256-GCM ───┴──▶ DEK (32B, random per seal)
                                                              │
                                              AES-256-GCM ────┴──▶ payload (JSON)
```

- **Envelope encryption**: the data key is random and re-wrapped when the
  password changes, so a rekey rewrites one block rather than the whole file.
- **Authenticated header**: `version` and the KDF parameters are passed as AAD
  to both blocks. Lowering the work factor, swapping in another vault's DEK, or
  rolling the format version forward makes the tag fail.
- **Fresh values per seal**: a new salt, DEK and IV every write. Two seals of
  the same payload produce different bytes.
- **Atomic replace**: the new envelope is written to `<file>.<pid>.tmp` and
  renamed over the old one, so an interrupted write cannot leave a half file.

### What it buys

- A stolen or backed-up vault file does not reveal any key without the password.
- The attack window narrows from "whenever the file exists" to "while the plugin
  is running and unlocked".
- Offline guessing costs scrypt work per attempt; the KDF parameters are
  authenticated, so the cost cannot be reduced by editing the file.

### What it does not buy

- **Any process running as you can read the decrypted keys while the vault is
  open.** This is the "not defended" row in §1 and the reason the plugin does
  not claim to protect against local attackers.
- **The password is held in this process's memory** when it comes from the
  environment, for as long as the plugin runs.
- **Deleting a key does not erase it from a filesystem snapshot or SSD
  wear-levelling.** Physical data remanence is out of scope.

### Password handling

Read from the environment variable named by `vault.passwordEnv`
(`DSH_APIKEYS_MASTER_PASSWORD` by default), or typed into the settings page,
which sends it over the same-origin bridge.

It is **never** accepted as a command-line argument — arguments appear in shell
history and in the process list, which would put the password somewhere far
worse than the vault file. The CLI reads it from the environment or from stdin.

It is never written to disk, never logged, and not included in the audit entry
for an unlock (only success or failure is recorded).

### Locked behaviour

`vault.failClosed` (default `true`):

- **`true`** — a call needing a key is refused with `vault-locked`. It does
  **not** fall back to the plaintext credential store, because that fallback
  would quietly defeat the whole point of the vault.
- **`false`** — falls back to the credential store. Deliberate: it keeps a
  machine usable when the password is not injected, at the cost of the vault's
  guarantee. The setting is named so that choosing it is visible.

### Migrating in, and out

- Enabling the vault and unlocking it moves existing keys from the credential
  store into the vault, **then deletes the plaintext records** — only after the
  encrypted copy is written. `vault.migrateCredentials: false` skips this.
- Keys the earlier GitHub-only plugin stored under `dsh-github/<account>` are
  adopted into the vault when it is unlocked, and into the credential store when
  it is not.
- There is no automatic migration *out*. To stop using the vault, copy the keys
  back through `apikey_key set` with the vault disabled.

---

## 5. The audit log

Records **who touched which account, when, and what happened** — never a key
value. Every entry carries `prev` (the previous entry's hash) and `hash`
(sha256 over the entry's canonical form), so:

- editing an entry breaks its own hash;
- removing one breaks the next entry's `prev` link;
- reordering breaks at the join.

`verify()` re-reads the file on every call. A log that reported "intact" from a
cached copy after someone edited it would be worse than no log at all, so the
viewer always reads what is on disk.

### What the chain proves, and what it does not

It proves **integrity**: the record has not changed since it was written.

It does **not** prove **authorship**. Anyone who can write the file can rebuild
a consistent chain from scratch — the test suite asserts exactly this, so the
limitation is documented rather than glossed over. Closing that gap needs a
signing key the attacker does not have, or an append-only sink off the machine,
neither of which a plugin can assume.

Treat the log as evidence about mistakes, not as a defence against an intruder
covering their tracks.

### Interaction with the vault

Audit entries are written in plaintext (they contain no secrets). Enabling the
vault does not encrypt them, and does not need to.

---

## 6. Response redaction

On by default. Two passes over every response body:

1. **Exact match** over the keys this call actually used. Short values (< 8
   characters) are skipped so a trivial string does not shred unrelated text.
   This is the pass that matters: the key the user stored came back.
2. **Pattern match** for credential shapes from known issuers (GitHub, npm,
   Slack, AWS, Google, GitLab, Vault, JWTs), to catch tokens the plugin never
   stored.

Object keys are redacted too, because a reflection can put a token in a property
name.

Limits, stated plainly:

- Redaction is a **guardrail against accident**, not a guarantee. A novel token
  format will not match a pattern.
- It runs on the parsed body; binary responses are surfaced as text and are not
  meaningfully scrubbed.
- Turning `redact.enabled` off disables both passes. The URL mask (§3) stays on
  regardless.

---

## 7. Upload allowlist

`apikey_upload` reads a file from this machine and sends it to a platform. That
is a data-exfiltration primitive if unbounded — a model that can name any path
could send an SSH key or `/etc/shadow` somewhere.

`upload.roots` bounds it:

- When `roots` is non-empty, only files inside those directories are readable.
- When empty, only the process working directory and your home directory.
- Resolution uses `path.relative` and rejects a result that is absolute or
  starts with `..`, so `../` does not escape.
- Symlinks are **not** resolved before the check — a symlink inside an allowed
  root that points outside it will be read. If that matters on your machine, put
  the allowlist below any directory you do not control.

`upload.enabled: false` removes the tool's ability to read anything at all.

---

## 8. Credential failover

Off by default. When on, a 401/403/429 moves to another account of the same
platform, and the failed account enters an exponential backoff.

The security-relevant property is that **failover is per platform and opt-in**:
accounts on different platforms are never mixed, and with rotation off an
account is exactly what you asked for. A call never silently uses a credential
you did not enable for that platform.

Rotation makes a call succeed when it would otherwise have failed. If you rely
on a specific account being the only one in use, leave it off.

---

## 9. Proxy behaviour

This plugin uses the global `fetch` (Node's undici). **Node's `fetch` does not
read `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` unless the runtime is told to.**

Measured on Node v24.16.0 from this repository:

- Default: a request ignores `HTTPS_PROXY` and goes direct.
- With `NODE_USE_ENV_PROXY=1` (or `node --use-env-proxy`), the request is sent
  through the proxy: the proxy received `CONNECT api.github.com:443`.

So **the correct fix is at the DSH process level**, not in this plugin:

```sh
NODE_USE_ENV_PROXY=1 dsh web
```

Consequences to know:

- DSH exposes no general-purpose HTTP client service to plugins (checked against
  the live service inventory), so there is nothing here to reuse.
- `NO_PROXY` handling, and proxy authentication, follow Node's implementation of
  `--use-env-proxy`, not this plugin's.
- If a proxy terminates TLS with its own CA, set `NODE_EXTRA_CA_CERTS`; otherwise
  requests fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
- When a call fails at the transport layer, `apikey_call` reports status `0`
  with a hint naming the proxy environment variables if any are set. That hint
  exists because this failure mode is otherwise very hard to diagnose.

---

## 10. Reporting a problem

If you find a way to make this plugin disclose a credential, or to reach a host
it should not, open an issue at
<https://github.com/XRC111/dsh-apikeys/issues>. Please do not include a real key
in the report; a description of the path is enough.
