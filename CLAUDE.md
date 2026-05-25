# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VS Code extension for **Acurast** development — Acurast is a decentralized serverless compute network on a Substrate chain. The extension wraps `@acurast/sdk` so users can manage encrypted wallets, edit `acurast.json`, and deploy jobs without installing the `acurast` CLI or hand-editing `.env`.

## Build / run

```bash
npm run build:dev        # build both extension + webview with sourcemaps (use for F5 dev loop)
npm run build            # production: regenerates icon font + minifies both bundles
npm run typecheck        # tsc --noEmit
npm run watch            # watch both extension and webview in parallel
npm run watch:ext        # watch extension bundle only
npm run watch:webview    # watch Svelte webview bundle only
npm run build:font       # regenerate woff/woff2 from media/icons/*.svg
```

Two separate bundles are produced:
- `dist/extension.js` — Node/CJS host bundle (esbuild CLI)
- `dist/studio/webview.js` — Browser/IIFE Svelte bundle (`scripts/build-webview.mjs` via esbuild JS API)

F5 in VS Code launches the Extension Development Host (config in `.vscode/launch.json`, preLaunchTask runs `build:dev`).

After any code change in the dev host, **`Cmd+R` reloads** — webviews do not hot-reload.

## Tests

```bash
npm run test:unit          # Vitest unit tests (Node, no VS Code)
npm run test:integration   # VS Code integration tests (requires display; use xvfb-run in CI)
npm test                   # both
```

Unit tests live in `src/test/unit/` and `src/test/webview/`. Integration tests live in `src/test/suite/` and are compiled separately via `tsconfig.test.json`.

## Releasing

See [RELEASE.md](./RELEASE.md) for the full step-by-step. Short version:

| Goal | How |
|---|---|
| Testable build for internal review | Actions → Publish Extension → `rc` |
| Marketplace preview for early adopters | Actions → Publish Extension → `pre-release` |
| Production release | `git tag v{version} && git push origin v{version}` |

Always bump `version` in `package.json` before tagging or dispatching.

## Architecture in one paragraph

The extension is a single Node bundle (`dist/extension.js`) built by esbuild from `src/extension.ts`. It registers **one** webview view (`acurastStudio` of type webview, named "Home") in the Acurast Studio activity bar container. The webview is a **Svelte 5** SPA (`dist/studio/webview.js`) with an internal router (`home | wallets | settings | deploy | history`) — the root `App.svelte` holds all reactive state and dispatches to five route components. Global styles live in `media/studio/global.css`; `studioPanel.ts` reads `media/studio/webview.html` and substitutes `{{CSP}}`, `{{STYLE_URI}}`, `{{SCRIPT_URI}}`, `{{NONCE}}` sentinels at runtime. The webview talks to the host via `postMessage`; the host delegates to existing command implementations (`vscode.commands.executeCommand('acurast.wallet.create', id)` etc.) rather than re-implementing flows. Services (wallet storage, SDK client, project config) live outside the panel so commands triggered from the palette or status bar share the same backing logic.

## Key modules

- **`src/extension.ts`** — `activate()` wires everything: `AcurastContext`, `WalletService`, `StudioPanel`, `WalletStatusBar`, command registrations, SDK disposal hook. Sets initial `acurast.studio.route = 'home'` context key.

- **`src/context.ts` — `AcurastContext`** — Source of truth for "which `acurast.json` is active". Stores the selected path in `workspaceState` under `acurast.activeConfigPath`. Detection order on activation: stored path → workspace-root `acurast.json` → recursive `findFiles('**/acurast.json')` if exactly one match. Exposes `configPath` (the file) and `projectRoot` (its dirname). Fires `onDidChangeActiveConfig`. Sets context key `acurast.isAcurastProject`.

- **`src/wallet/walletService.ts` — `WalletService`** — Multi-wallet vault. Schema in SecretStorage key `acurast.wallets.v2`: `{ v: 2, wallets: StoredWallet[], activeId }`. Each wallet keeps `{ info, encrypted }` where `info` is public (id/address/publicKey/name/description) and `encrypted` is AES-256-GCM ciphertext of the mnemonic. ID is derived from `publicKey.slice(0, 16)` so re-importing the same mnemonic is rejected with "already exists". Uses `@polkadot/keyring` (sr25519, SS58 prefix 42).

- **`src/wallet/crypto.ts`** — AES-256-GCM + PBKDF2-SHA256 (210k iters, OWASP 2023). Mnemonic is encrypted at rest *inside* the SecretStorage entry so a keychain dump still requires the password.

- **`src/sdk/acurastClient.ts`** — Singleton `AcurastService` connections (one per network). Lazy-connect, cached across calls, disposed on extension deactivate. The wrapper around `getBalance` just delegates — **do not divide again** (SDK already returns ACU, not planck; see commit history).

- **`src/sdk/constants.ts`** — RPC endpoints and IPFS proxy defaults. Mainnet: `wss://public-rpc.mainnet.acurast.com`; Canary: `wss://public-rpc.canary.acurast.com`. IPFS uses Acurast's hosted proxy (`https://ipfs-proxy.acurast.prod.gke.papers.tech`) — no Pinata key needed for the default path.

- **`src/studio/studioPanel.ts`** — Host class (~900 lines). Holds a `_route` field and posts `{type: 'route'}` to the webview on `navigate(route)`. Polls balance every 30s while on the `wallets` route. Sets context key `acurast.studio.route` so `view/title` menus can hide/show the Home button. The `html()` method reads `media/studio/webview.html` and replaces the four `{{...}}` sentinels — no inline template. Handles history messages: `history.load` (paginated local records), `history.fetchOnline` (partial-key chain query for the active wallet's jobs), `history.remove`, `history.removePathInfo`, `history.openFolder`.

- **`src/studio/types.ts`** — All shared TypeScript types used by both the host and the webview: `Route`, `InMsg`, all `*Msg` interfaces, `DeployStageId`, `StageStatus`, `DeployStage`, `DeployState`, etc. Re-exports `WalletInfo` from `../wallet/walletService`.

- **`src/studio/webview/App.svelte`** — Svelte 5 root component. Holds all global state with `$state` runes (`route`, `wallets`, `balance`, `config`, `deploy`, `ctx`, `historyState`). Registers the `window.addEventListener('message')` handler in a `$effect` with cleanup. Routes to the five page components via `{#if}` blocks.

- **`src/studio/webview/Home.svelte`**, **`Wallets.svelte`**, **`Settings.svelte`**, **`Deploy.svelte`**, **`History.svelte`** — Route components. Each receives typed props; uses `$derived`/`$derived.by` for computed values. All DOM events use `onclick={}` (Svelte 5 syntax — not `on:click`).

- **`src/studio/webview/History.svelte`** — Two-section layout: **Local** (paginated via `history.load` with offset, accumulated client-side) and **On-chain** (accordion, fetched on demand via `history.fetchOnline`, client-side paginated). On-chain cards decode `JobRegistration` fields (schedule, slots, reward, modules, script URL) and show a derived status badge (active/scheduled/expired) from `startTime`/`endTime`.

- **`src/deployments/deploymentStore.ts`** — Wraps `vscode.Memento` (globalState, key `acurast.deployments.v1`) for cross-workspace deployment history persistence. Methods: `getAll()`, `save(record)`, `removePathInfo(id)`, `remove(id)`.

- **`src/studio/webview/lib/vscode.ts`** — Calls `acquireVsCodeApi()` once and exports a `send(type, extra)` helper. Import directly in any component — do not prop-drill the API.

- **`src/studio/webview/lib/icons.ts`** — SVG string constants exported as `ICONS`. Use `{@html ICONS.xxx}` in templates (safe: these are static, not user input).

- **`src/studio/webview/lib/format.ts`** — Shared formatting utilities for all webview components: `planckToAcu`, `planckToFiat`, `acuToFiat`, `fmtFiat`, `fmtTimestamp`, `fmtClock`, `truncate`, `fmtMs`. Add new display helpers here rather than inlining them in components.

- **`media/studio/global.css`** — All VS Code theme-variable base styles shared across components (`.wallet-card`, `.nav-card`, `.stage`, etc.). Loaded via `<link>` in `webview.html`.

- **`scripts/build-webview.mjs`** — esbuild JS API config for the Svelte bundle. Must use the JS API (not CLI) because esbuild plugins require it. `css: 'injected'` bundles component `<style>` blocks into the JS.

- **`svelte.config.js`** — Tells the VS Code Svelte language server to use Svelte 5 runes mode (`compilerOptions: { runes: true }`). Without this, the IDE reports false `$derived`/`$state` errors.

- **`src/commands/`** — Each command is a thin function exported from its file and registered in `commands/index.ts`. Wallet commands live separately in `src/wallet/walletCommands.ts` because they only depend on `WalletService`.

## Cross-cutting concerns / sharp edges

- **SDK is ESM, extension is CJS.** `tsconfig.json` uses `module: ESNext` + `moduleResolution: Bundler` so tsc accepts the imports; esbuild handles the actual ESM→CJS conversion at bundle time. Don't change `module` back to `Node16`.

- **`process.cwd()` is read-only in production.** When VS Code is launched from the Dock/Spotlight on macOS, cwd is `/`. The Acurast SDK's `uploadScript` writes `temp_script.js` to cwd with no override. `deploy.ts` works around this by `process.chdir()`-ing to a fresh `os.tmpdir()` scratch dir for the duration of the deploy, restoring in `finally`. **Do not remove this workaround** until the upstream SDK lands a fix.

- **`fileUrl` resolution.** SDK does `fs.statSync(config.fileUrl)` against cwd. `deploy.ts` resolves `config.fileUrl` to an absolute path against the project root (the dir containing `acurast.json`) before handing the config to `deployProject`. IPFS hashes / `ipfs://` / `https://` URLs are left untouched.

- **Activation events are auto-generated** from `contributes.commands` and `contributes.views` (VS Code ≥ 1.74). Only `workspaceContains:acurast.json` is listed explicitly in `activationEvents`. Don't add `onCommand:*` or `onView:*` entries — they'd be linted as redundant.

- **Icons.** Custom icons (Acurast logo, status bar) come from a webfont generated by `fantasticon` from SVGs in `media/icons/`. Output lives at `media/font/acurast-icons.woff{,2}`. `package.json` `contributes.icons` maps `acurast-logo` to codepoint `\E000`. To tweak the glyph size, edit the source SVG's viewBox (with `normalize: false` in `.fantasticonrc.json` to preserve the padding) and run `npm run build:font`. Codicons (`$(home)`, `$(cloud-upload)`, etc.) are used everywhere else and don't need the font build.

- **Webview uses Svelte 5 runes only.** Use `$state`, `$derived`, `$derived.by`, `$effect`, `$props` — never Svelte 4 patterns (`$:`, `export let`, `writable()` stores). The `{@html}` directive is only acceptable for the static SVG strings in `lib/icons.ts`; never use it for user-supplied content. Svelte auto-escapes all `{expression}` interpolations.

- **On-chain job queries use partial-key lookup.** `api.query.acurast.storedJobRegistration.entries(multiOrigin)` where `multiOrigin = api.createType('AcurastCommonMultiOrigin', { acurast: address })` fetches only a single user's jobs instead of scanning all chain jobs. Decode the value with `api.createType('Option<AcurastCommonJobRegistration>', value).unwrap().toJSON()` — same approach as the SDK's internal `codecToJobRegistration`. The job `localId` is extracted from `key.args.at(1)` cast to `u128`.

- **Deployment history uses `globalState`, not `workspaceState`.** `DeploymentStore` writes to `extensionContext.globalState` (key `acurast.deployments.v1`) so the history is visible regardless of which workspace folder is open. `workspaceState` would hide records whenever the user switches projects.

- **Status bar lives separately.** `WalletStatusBar` listens on `wallet.onDidChange`, hides when no active wallet exists, click executes `acurast.studio.showWallets` which calls `studioPanel.navigate('wallets')`.

- **The right-click "Set as Active acurast.json"** menu entry in `explorer/context` / `editor/context` uses `when: "resourceFilename == acurast.json"`. The command is hidden from the command palette (`when: "false"`) because it requires a URI argument; use `acurast.chooseConfig` for the palette flow.

## When you add a new feature

- **New webview route**: (1) Add the route name to the `Route` type in `src/studio/types.ts`. (2) Create `src/studio/webview/MyRoute.svelte` with typed `$props()`. (3) Import and add a `{:else if route === 'myroute'}` branch in `App.svelte`. (4) Update the `routeTitles` map in `App.svelte`. (5) Set `acurast.studio.route` context key in `studioPanel.ts` for any `view/title` buttons that should appear only on that route.
- **New command callable from the webview**: add an `onclick={() => send('wallet', { action: 'newAction', id: w.id })}` call in the appropriate Svelte component, then handle it in `studioPanel.ts`'s `handle()` method with `vscode.commands.executeCommand(...)`. Keep the actual implementation in `src/commands/` or `src/wallet/walletCommands.ts` so the palette gets it for free.
- **New shared type**: add to `src/studio/types.ts` and export it. Import with `import type { ... }` in both host and webview files (required by `verbatimModuleSyntax`).
- **New RPC or IPFS endpoint**: add to `src/sdk/constants.ts`. Per-network overrides come from VS Code setting `acurast.rpcOverrides`.
