# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VS Code extension for **Acurast** development — Acurast is a decentralized serverless compute network on a Substrate chain. The extension wraps `@acurast/sdk` so users can manage encrypted wallets, edit `acurast.json`, and deploy jobs without installing the `acurast` CLI or hand-editing `.env`.

## Build / run

```bash
npm run build:dev    # esbuild bundle with sourcemaps (use for F5 dev loop)
npm run build        # production: regenerates icon font + minifies bundle
npm run typecheck    # tsc --noEmit
npm run watch        # esbuild watch mode
npm run build:font   # regenerate woff/woff2 from media/icons/*.svg
```

F5 in VS Code launches the Extension Development Host (config in `.vscode/launch.json`, preLaunchTask runs `build:dev`).

There are no tests yet — `package.json` has no test script.

After any code change in the dev host, **`Cmd+R` reloads** — webviews do not hot-reload.

## Architecture in one paragraph

The extension is a single Node bundle (`dist/extension.js`) built by esbuild from `src/extension.ts`. It registers **one** webview view (`acurastStudio` of type webview, named "Home") in the Acurast Studio activity bar container. That webview is a vanilla-JS SPA with an internal router (`home | wallets | settings`) — all UI lives in `src/studio/studioPanel.ts` as a single inlined HTML/CSS/JS template. The webview talks to the host via `postMessage`; the host delegates to existing command implementations (`vscode.commands.executeCommand('acurast.wallet.create', id)` etc.) rather than re-implementing flows. Services (wallet storage, SDK client, project config) live outside the panel so commands triggered from the palette or status bar share the same backing logic.

## Key modules

- **`src/extension.ts`** — `activate()` wires everything: `AcurastContext`, `WalletService`, `StudioPanel`, `WalletStatusBar`, command registrations, SDK disposal hook. Sets initial `acurast.studio.route = 'home'` context key.

- **`src/context.ts` — `AcurastContext`** — Source of truth for "which `acurast.json` is active". Stores the selected path in `workspaceState` under `acurast.activeConfigPath`. Detection order on activation: stored path → workspace-root `acurast.json` → recursive `findFiles('**/acurast.json')` if exactly one match. Exposes `configPath` (the file) and `projectRoot` (its dirname). Fires `onDidChangeActiveConfig`. Sets context key `acurast.isAcurastProject`.

- **`src/wallet/walletService.ts` — `WalletService`** — Multi-wallet vault. Schema in SecretStorage key `acurast.wallets.v2`: `{ v: 2, wallets: StoredWallet[], activeId }`. Each wallet keeps `{ info, encrypted }` where `info` is public (id/address/publicKey/name/description) and `encrypted` is AES-256-GCM ciphertext of the mnemonic. ID is derived from `publicKey.slice(0, 16)` so re-importing the same mnemonic is rejected with "already exists". Uses `@polkadot/keyring` (sr25519, SS58 prefix 42).

- **`src/wallet/crypto.ts`** — AES-256-GCM + PBKDF2-SHA256 (210k iters, OWASP 2023). Mnemonic is encrypted at rest *inside* the SecretStorage entry so a keychain dump still requires the password.

- **`src/sdk/acurastClient.ts`** — Singleton `AcurastService` connections (one per network). Lazy-connect, cached across calls, disposed on extension deactivate. The wrapper around `getBalance` just delegates — **do not divide again** (SDK already returns ACU, not planck; see commit history).

- **`src/sdk/constants.ts`** — RPC endpoints and IPFS proxy defaults. Mainnet: `wss://public-rpc.mainnet.acurast.com`; Canary: `wss://public-rpc.canary.acurast.com`. IPFS uses Acurast's hosted proxy (`https://ipfs-proxy.acurast.prod.gke.papers.tech`) — no Pinata key needed for the default path.

- **`src/studio/studioPanel.ts`** — The whole UI. ~700 lines, deliberately single-file. Holds a `_route` field and posts `{type: 'route'}` to the webview on `navigate(route)`. Polls balance every 30s while on the `wallets` route. Sets context key `acurast.studio.route` so `view/title` menus can hide/show the Home button.

- **`src/commands/`** — Each command is a thin function exported from its file and registered in `commands/index.ts`. Wallet commands live separately in `src/wallet/walletCommands.ts` because they only depend on `WalletService`.

## Cross-cutting concerns / sharp edges

- **SDK is ESM, extension is CJS.** `tsconfig.json` uses `module: ESNext` + `moduleResolution: Bundler` so tsc accepts the imports; esbuild handles the actual ESM→CJS conversion at bundle time. Don't change `module` back to `Node16`.

- **`process.cwd()` is read-only in production.** When VS Code is launched from the Dock/Spotlight on macOS, cwd is `/`. The Acurast SDK's `uploadScript` writes `temp_script.js` to cwd with no override. `deploy.ts` works around this by `process.chdir()`-ing to a fresh `os.tmpdir()` scratch dir for the duration of the deploy, restoring in `finally`. **Do not remove this workaround** until the upstream SDK lands a fix.

- **`fileUrl` resolution.** SDK does `fs.statSync(config.fileUrl)` against cwd. `deploy.ts` resolves `config.fileUrl` to an absolute path against the project root (the dir containing `acurast.json`) before handing the config to `deployProject`. IPFS hashes / `ipfs://` / `https://` URLs are left untouched.

- **Activation events are auto-generated** from `contributes.commands` and `contributes.views` (VS Code ≥ 1.74). Only `workspaceContains:acurast.json` is listed explicitly in `activationEvents`. Don't add `onCommand:*` or `onView:*` entries — they'd be linted as redundant.

- **Icons.** Custom icons (Acurast logo, status bar) come from a webfont generated by `fantasticon` from SVGs in `media/icons/`. Output lives at `media/font/acurast-icons.woff{,2}`. `package.json` `contributes.icons` maps `acurast-logo` to codepoint `\E000`. To tweak the glyph size, edit the source SVG's viewBox (with `normalize: false` in `.fantasticonrc.json` to preserve the padding) and run `npm run build:font`. Codicons (`$(home)`, `$(cloud-upload)`, etc.) are used everywhere else and don't need the font build.

- **Webviews are vanilla JS.** React was tried and removed (~196kb per webview, no shared chunk across iframes). The rule of thumb: tree-shaped data → native `TreeDataProvider`; static + 1–2 buttons → vanilla webview; complex forms or multi-state UI → reconsider React only if vanilla starts hurting. The Configuration form was the borderline case and is still vanilla.

- **Status bar lives separately.** `WalletStatusBar` listens on `wallet.onDidChange`, hides when no active wallet exists, click executes `acurast.studio.showWallets` which calls `studioPanel.navigate('wallets')`.

- **The right-click "Set as Active acurast.json"** menu entry in `explorer/context` / `editor/context` uses `when: "resourceFilename == acurast.json"`. The command is hidden from the command palette (`when: "false"`) because it requires a URI argument; use `acurast.chooseConfig` for the palette flow.

## When you add a new feature

- **New webview route**: add to the `Route` type in `studio/studioPanel.ts`, add render function, update the topbar title/icon maps, handle `navigate('newroute')`. Set `acurast.studio.route` context for any title-bar buttons that should show only on that route.
- **New command callable from the wallet card or settings panel**: add a `data-walletact` or `data-cfgact` attribute, then route it through the existing `case` block in `handle()` to `executeCommand(...)`. Keep the actual implementation in `src/commands/` or `src/wallet/walletCommands.ts` so the palette gets it for free.
- **New RPC or IPFS endpoint**: add to `src/sdk/constants.ts`. Per-network overrides come from VS Code setting `acurast.rpcOverrides`.
