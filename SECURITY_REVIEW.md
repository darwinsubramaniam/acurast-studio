# Security Review — Acurast Studio VS Code Extension

**Date:** 2026-07-15
**Reviewed revision:** `claude/security-audit-review-ka0dpq` (base `246ced9`)
**Reviewer:** Automated security audit (Claude Code)
**Scope:** Full source tree under `src/`, webview bundle, host↔webview `postMessage`
boundary, cryptography, wallet vault, deploy/build pipeline, network clients,
extension manifest (`package.json`), and declared dependencies.

---

## 1. Executive summary

Acurast Studio is a wallet-bearing VS Code extension: it stores encrypted
mnemonics, signs on-chain extrinsics, and runs project build/deploy pipelines.
The **cryptographic core and secret handling are well built** — AES‑256‑GCM +
PBKDF2‑SHA256 (210k), per‑record salt/IV, mnemonics encrypted *inside*
SecretStorage, no secret logging, no `{@html}` XSS, a nonce‑based CSP, and an
explicit Workspace‑Trust posture for the shell‑executing build step.

The findings below cluster around the **trust boundary between a workspace
(repository) and the extension host**. The team correctly gated the obvious
shell sink (`build.command`) behind Workspace Trust, but one comparable sink —
the `acurast.cliPath` executable, run via `execFile` — is **not** protected the
same way and is overridable from a repository's `.vscode/settings.json`. A
second cluster concerns **path containment** on config‑controlled file paths
(`fileUrl`, `build.output`) that can escape the project directory. The
remaining items are defense‑in‑depth hardening of the (trusted, CSP‑locked)
webview boundary.

### Severity tally

| Severity | Count | IDs |
|---|---|---|
| High | 1 | H‑1 |
| Medium | 3 | M‑1, M‑2, M‑3 |
| Low | 6 | L‑1 … L‑6 |
| Informational | 3 | I‑1, I‑2, I‑3 |

### Severity scale

| Level | Meaning |
|---|---|
| **High** | Repository‑ or attacker‑controlled input reaches code/file execution and is **not** fully mitigated by an existing gate. |
| **Medium** | Requires a user action or a specific precondition, or is mitigated by Workspace Trust but has a residual weakness. |
| **Low** | Defense‑in‑depth gap; exploitable only under a compromised‑webview or edge‑case model. |
| **Informational** | Design residual or hardening note; no direct exploit path today. |

---

## 2. Findings

### H‑1 — `acurast.cliPath` is repository‑overridable and executed, bypassing the Workspace‑Trust gate

**Severity:** High
**Location:** `src/studio/studioPanel.ts:1410` (execution), `src/context.ts:72‑74`
(resolution), `package.json` `contributes.configuration` (scope) &
`capabilities.untrustedWorkspaces` (missing restriction).

```ts
// context.ts
get cliPath(): string {
  return vscode.workspace.getConfiguration('acurast').get<string>('cliPath', 'acurast');
}
// studioPanel.ts
execFile(this.ctx.cliPath, ['devtools', String(localId)], (err, stdout, stderr) => { … });
```

`acurast.cliPath` is a plain `window`‑scoped setting (verified: no `machine`
scope). It can therefore be set by a workspace‑level `.vscode/settings.json`
committed into any repository. It is then executed via `execFile` when the user
fetches the devtools URL after a deploy.

Critically, the extension declares `capabilities.untrustedWorkspaces.supported =
"limited"` but does **not** list `restrictedConfigurations`. VS Code only defers
a workspace setting to the trusted state when the extension names it in
`restrictedConfigurations`; otherwise the workspace value applies **even in an
untrusted workspace**. So a malicious repo can point `cliPath` at an arbitrary
executable (e.g. `/tmp/evil`, or `node`/`bash` with a payload path) and have it
run — the exact repository‑driven code‑execution class that Workspace Trust
exists to prevent, and which the team already blocked for `build.command`.

**Reachability caveat:** the devtools `execFile` requires a prior deploy in the
session (a `jobIds` entry) before the button that triggers it appears, so it is
not a zero‑click open‑the‑folder trigger. This lowers likelihood but not the
severity of the primitive.

**Recommendation:**
1. Add a `restrictedConfigurations` list to `capabilities.untrustedWorkspaces`
   in `package.json` naming `acurast.cliPath` (and, per L‑6, `acurast.rpcOverrides`
   and `acurast.tunnelRelays`), so a repository cannot override them in an
   untrusted workspace.
2. Consider marking `acurast.cliPath` with `"scope": "machine"` so it is
   user/machine‑level only and never workspace‑overridable.
3. Optionally assert `vscode.workspace.isTrusted` before the devtools `execFile`,
   mirroring the `build.command` gate.

---

### M‑1 — `build.command` runs through a shell; `runProjectBuild` has no internal trust guard and inherits full `process.env`

**Severity:** Medium (High primitive, reduced by the Workspace‑Trust gate)
**Location:** `src/commands/build.ts:129`; callers `build.ts:179`, `deploy.ts:78`.

```ts
const child = spawn(build.command, { cwd, shell: true, env: process.env });
```

`build.command` comes verbatim from `acurast.json` and runs through a shell, so
pipes / `;` / `$()` / `&&` all execute. This is arbitrary code execution driven
by repository content.

**Mitigation present (good):** both entry points gate on Workspace Trust
(`build.ts:179` and `deploy.ts:78`), the manifest declares
`untrustedWorkspaces: limited` with an accurate description, and deploy shows a
confirm modal. Residual weaknesses:

- `runProjectBuild` (the exported executor, `build.ts:98`) performs **no** trust
  check itself — it relies on every caller remembering the gate. A future caller
  that forgets silently bypasses it.
- The child inherits the **entire** `process.env` of the extension host, so a
  malicious (trusted) build command can exfiltrate every environment variable of
  the VS Code process, not just the project's.
- The confirm modal renders the command inline; a long/obfuscated command is
  easy to approve without reading.

**Recommendation:** assert `vscode.workspace.isTrusted` inside `runProjectBuild`
itself; pass a curated env (project `.env` + a minimal allowlist) rather than the
full `process.env`; and consider truncating/annotating the command in the confirm
modal.

---

### M‑2 — `fileUrl` / `build.output` path traversal → arbitrary file read + IPFS exfiltration

**Severity:** Medium
**Location:** `src/commands/deploy.ts:260‑267` (`resolveAgainst`), used at
`deploy.ts:85‑88`; `build.ts:100,148`.

```ts
function resolveAgainst(root, fileUrl) {
  if (path.isAbsolute(fileUrl)) return fileUrl;                 // absolute passed through
  if (/^(ipfs:\/\/|https?:\/\/|Qm…|b…)/.test(fileUrl)) return fileUrl;
  return path.resolve(root, fileUrl);                           // '../..' escapes root
}
```

`fileUrl` is config‑controlled. An absolute path is returned unchanged and a
relative path is `path.resolve`‑joined with **no containment check**, so
`../../../../home/user/.ssh/id_rsa` or an absolute secret path resolves to a real
file that the SDK then reads (`fs.statSync`) and uploads to IPFS / submits with
the deploy — i.e. config‑controlled arbitrary file read plus network
exfiltration. The same unchecked `path.resolve(projectRoot, …)` pattern applies
to `build.cwd` (sets the shell cwd anywhere) and `build.output` (probes file
existence anywhere).

**Reachability:** unlike M‑1, this does **not** require Workspace Trust — deploy
without a `build.command` is *not* trust‑gated (`deploy.ts:78` only blocks when a
build command is present). The user must click Deploy and enter their wallet
password, but nothing confines the path to the project.

**Recommendation:** after resolving, verify the real path stays under
`projectRoot` (e.g. `path.relative(root, resolved)` must not start with `..` and
must not be absolute); reject absolute `fileUrl`s that point outside the project
unless explicitly whitelisted. Apply the same containment to `build.cwd` /
`build.output`.

---

### M‑3 — Distro catalog SHA256 is accepted without format validation

**Severity:** Medium
**Location:** `src/sdk/distroFetch.ts:75‑82`.

```ts
const sha256 = quoted(source, new RegExp(`TARBALL_SHA256\\['${ARCH}'\\]="([^"]+)"`));
if (!url || !sha256 || !url.endsWith('.tar.xz')) return null;   // non-empty is the only check
```

The integrity hash is regex‑scraped from upstream `distro-plugins/*.sh` and
accepted merely for being non‑empty — there is no `^[a-f0-9]{64}$` check (contrast
`newProject.ts:21` `SHA256_RE`, which *does* validate manually entered hashes). A
truncated, malformed, or tampered hash flows unchecked into `acurast.json` and
becomes the integrity value the processor later trusts. Host exposure is limited
(URL/host is hard‑pinned to GitHub via `API`/`RAW` constants, and the processor
re‑verifies on download), so this is an integrity‑hygiene gap rather than direct
RCE, but it silently weakens the one integrity control in the image pipeline.

**Recommendation:** validate the parsed hash against `/^[a-f0-9]{64}$/` in
`parseDistroPlugin` before accepting the image; reject the entry otherwise.

---

### L‑1 — `devtools.openUrl` opens a URL without the https scheme guard applied to its sibling handler

**Severity:** Low
**Location:** `src/studio/studioPanel.ts:347‑348`.

```ts
case 'devtools.openUrl':
  if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(msg.url));   // no scheme check
```

The immediately following `openExternal` handler (`studioPanel.ts:350‑364`) was
deliberately hardened to only pass `https` URIs, with a comment noting it "stops
any future message from opening `file:`/`command:`/`vscode:` URIs via this
channel." `devtools.openUrl` lacks that guard, so under a compromised‑webview
model it could open a `command:`/`file:`/`vscode:` URI. Today the URL originates
from a host‑side regex that only matches `https?://`, but the inconsistency
should be closed.

**Recommendation:** apply the same `Uri.parse(msg.url, true)` + `scheme === 'https'`
check used by `openExternal`.

---

### L‑2 — `history.openFolder` reveals an arbitrary filesystem path

**Severity:** Low
**Location:** `src/studio/studioPanel.ts:399‑400`.

```ts
case 'history.openFolder':
  if (msg.path) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
```

`msg.path` is an unchecked webview‑supplied string handed to `revealFileInOS`,
which opens any path on disk in the OS file manager. Low impact (reveal, not
read/exec) and only meaningful under a compromised webview, but it should be
confined to known deployment/project roots.

**Recommendation:** validate `msg.path` against the set of paths the extension
actually tracks (deployment records / project roots) before revealing.

---

### L‑3 — CSP nonce generated with `Math.random()`

**Severity:** Low
**Location:** `src/studio/studioPanel.ts:2102‑2106`.

```ts
function getNonce(): string {
  const chars = '…';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
```

The `script-src 'nonce-…'` value is generated with `Math.random()`, which is not
a CSPRNG and is predictable. A predictable script‑nonce undermines the CSP if any
HTML‑injection sink ever appears. `crypto` is already imported in this file
(`randomUUID`, line 3), so the fix is free.

**Recommendation:** generate the nonce with `crypto.randomBytes(16).toString('base64')`
(or `randomUUID()`).

---

### L‑4 — No runtime validation on the `postMessage` boundary; privileged handlers forward unvalidated args

**Severity:** Low
**Location:** `src/studio/studioPanel.ts:246,249` (blind `InMsg` cast);
`studioPanel.ts:368‑376` (`processors.advertise`); `App.svelte:107‑109,191`
(inbound, no shape check).

Both directions blind‑cast the message (`msg as InMsg` / `event.data as OutMsg`)
with no shape/type‑guard validation and no origin check (the latter is standard
for VS Code webviews, which the platform sandboxes). Notably,
`processors.advertise` forwards `walletId`, `processor`, `modules`, `network`,
and the full `newAd` pricing struct straight into a wallet‑signed `advertiseFor`
extrinsic with no bounds/format/ownership validation at this layer. Command
*names* are always hardcoded strings (no `executeCommand(attackerName)`), and the
destructive flows (delete/deregister/bulkDelete) are gated behind a confirm modal
+ password — those are good. Only relevant under a compromised webview, but the
signed‑extrinsic path deserves defensive validation.

**Recommendation:** add lightweight runtime type guards in `handle()`; validate
addresses (SS58), numeric bounds, and wallet ownership before signing in the
advertise/deregister paths.

---

### L‑5 — Vulnerable transitive dependency `elliptic` via `@acurast/sdk`

**Severity:** Low
**Location:** `package.json` → `@acurast/sdk` → `elliptic`.

`npm audit` reports `elliptic` (GHSA‑848j‑6mx2‑7j84, "Uses a Cryptographic
Primitive with a Risky Implementation", low severity) pulled in transitively by
`@acurast/sdk`. The clean fix is a breaking SDK change, so it cannot be applied
blindly.

**Recommendation:** track the `@acurast/sdk` release that ships a fixed
`elliptic`; add an `overrides`/`resolutions` pin if a compatible patched version
exists; re‑run `npm audit` in CI.

---

### L‑6 — `rpcOverrides` / `tunnelRelays` are repository‑overridable

**Severity:** Low
**Location:** `src/extension.ts:34‑37` (`rpcOverrides`), `src/sdk/constants.ts`
+ tunnel code (`tunnelRelays`); scopes verified `window`.

A malicious workspace `.vscode/settings.json` can redirect the chain RPC endpoint
and tunnel relay IPs. Private keys never leave the host (signing is local), so the
impact is limited to integrity of displayed data (balances/history) and steering
tunnel/relay targeting — not key theft. Grouped with H‑1's remediation.

**Recommendation:** include these in `restrictedConfigurations` (see H‑1) so a
repository cannot override them without Workspace Trust.

---

### I‑1 — CSP allows `style-src 'unsafe-inline'`

**Severity:** Informational
**Location:** `src/studio/studioPanel.ts:1988`.

Inline styles are permitted (Svelte injects component styles). No script vector,
but it weakens defense‑in‑depth. Consider nonced/hashed styles if practical; not
required.

---

### I‑2 — Mnemonics and passwords traverse `postMessage` in plaintext and dwell in webview memory

**Severity:** Informational (by‑design residual)
**Location:** `studioPanel.ts:455,490‑491` (mnemonic → webview);
`types.ts:29,34‑40` + `CreateWallet.svelte`/`RevealPhrase.svelte`/`ImportWallet.svelte`
(password/mnemonic → host).

Creating/revealing a wallet necessarily sends the plaintext mnemonic to the
webview to display it, and passwords travel webview→host. These are held in
webview `$state` and consumed transiently on the host (never persisted, never
logged — verified). This is inherent to the in‑panel backup/reveal UX, but it is
the asset a webview compromise would target, which is why the L‑series webview
hardening matters. No change required; documented so the trade‑off is explicit.

---

### I‑3 — `process.chdir` mutates global state on the shared extension host during deploy

**Severity:** Informational
**Location:** `src/commands/deploy.ts:207‑210,252`.

Deploy `process.chdir`s the whole extension host to a temp scratch dir (a
documented workaround for the SDK writing `temp_script.js` to cwd) and restores
in `finally`. During the `await`‑heavy deploy, any concurrent code resolving a
relative path sees the scratch dir; an interruption before `finally` leaves cwd
inside a dir that is later removed. Correctness/robustness hazard, not an
injection. Keep until the upstream SDK accepts a cwd override, but consider
serializing deploys and asserting cwd restoration.

---

## 3. Security controls done well (positive findings)

- **At‑rest cryptography (`src/wallet/crypto.ts`):** AES‑256‑GCM with a random
  12‑byte IV and random 16‑byte salt **per encryption**, PBKDF2‑SHA256 at 210k
  iterations (OWASP 2023), NFKC password normalization, GCM auth‑tag verified on
  decrypt, and the stored iteration count honored on decrypt for
  forward‑compatibility. Solid construction.
- **Layered secret storage (`walletService.ts`):** the mnemonic is AES‑encrypted
  *inside* the SecretStorage entry, so a raw keychain dump still requires the
  password. Re‑import of the same mnemonic is rejected via a public‑key‑derived id.
- **No secret logging:** no `console`/output‑channel/`log` sink emits passwords,
  mnemonics, or keys anywhere in the tree (verified by grep); the only wallet‑area
  log is a generic chain‑watch error string.
- **No `{@html}` XSS:** all ~120 `{@html}` sites render static `ICONS` SVG
  constants; every user/network value (wallet names, addresses, mnemonic words,
  chain event text) is escaped text interpolation.
- **CSP with a script nonce** and `default-src 'none'`; `openExternal` explicitly
  hardened to https‑only.
- **`execFile` (argv array, no shell)** for the git‑hash and devtools calls — no
  argument injection there (the residual risk in H‑1 is the *executable path*, not
  the args).
- **Workspace Trust declared and enforced** for the `build.command` shell sink,
  with an accurate `untrustedWorkspaces` description.
- **API keys** (fiat exchangers) are stored in SecretStorage and never echoed back
  to the webview (only a boolean `hasApiKey`).
- **Dev‑only demo seed** (with a hardcoded mnemonic) is behind an esbuild
  compile‑time flag (`__ACURAST_DEV_SEED__`) and dead‑code‑eliminated from shipped
  builds; `src/` is excluded from the package via `.vscodeignore`.

---

## 4. Prioritized remediation

1. **H‑1** — add `restrictedConfigurations` (`acurast.cliPath`, `acurast.rpcOverrides`,
   `acurast.tunnelRelays`) to `capabilities.untrustedWorkspaces`, and/or make
   `cliPath` `machine`‑scoped. *(Also resolves L‑6.)*
2. **M‑2** — enforce `projectRoot` containment in `resolveAgainst` and on
   `build.cwd`/`build.output`.
3. **M‑1** — assert `isTrusted` inside `runProjectBuild`; pass a curated env instead
   of full `process.env`.
4. **M‑3** — validate parsed SHA256 with `/^[a-f0-9]{64}$/`.
5. **L‑1 / L‑3** — https‑guard `devtools.openUrl`; CSPRNG for the CSP nonce.
6. **L‑2 / L‑4** — confine `history.openFolder` paths; add runtime shape validation
   and pre‑sign checks on `processors.advertise`.
7. **L‑5** — track/pin a fixed `elliptic` via `@acurast/sdk`.

---

## 5. Methodology & scope notes

Reviewed statically: cryptography and wallet vault; the full host↔webview
`postMessage` protocol and every `handle()` case; deploy/build/distro pipelines
for injection, path traversal, SSRF, and integrity gaps; the extension manifest
for trust capabilities and setting scopes; and declared/transitive dependencies
(`npm audit`). No dynamic exploitation was performed. Severity reflects the
repository‑as‑attacker and compromised‑webview threat models appropriate to a
wallet‑bearing editor extension. This review is a point‑in‑time assessment of the
stated revision and does not replace a professional third‑party audit before a
production wallet release.
