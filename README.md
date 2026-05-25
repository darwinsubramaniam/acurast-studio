# Acurast Studio

VS Code extension for [Acurast](https://acurast.com) serverless development — manage wallets, configure jobs, and deploy to the decentralized compute network without leaving your editor.

## Features

- **Acurast Studio panel** — activity bar view with wallet management, project config, deployment, and history in one place
- **Wallet vault** — create, import, rename, and delete sr25519 wallets; mnemonics encrypted with AES-256-GCM + PBKDF2 at rest inside VS Code's SecretStorage
- **One-click deploy** — packages your script, uploads to IPFS, and submits the job to Mainnet or Canary
- **Cost estimation** — preview ACU spend before deploying, with optional fiat conversion
- **Deployment history** — persistent cross-workspace log of every deployment; records project path, tx hash, IPFS hash, and job IDs
- **On-chain history** — fetch your live job registrations directly from the chain; shows schedule, slot count, reward, required modules, and derived status (active / scheduled / expired)
- **`acurast.json` integration** — JSON schema validation, multi-config workspace support, right-click to set active config
- **Live balance polling** — 30-second balance refresh on the Wallets route

## Requirements

- VS Code 1.90+
- A workspace containing an `acurast.json` file (extension auto-activates on detection)

## Getting started

1. Install the extension.
2. Open a workspace with an `acurast.json` (or run **Acurast: Init Project** to scaffold one).
3. Click the Acurast logo in the activity bar to open Acurast Studio.
4. Create or import a wallet, then hit **Deploy**.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `acurast.network` | `mainnet` | Target network (`mainnet` or `canary`) |
| `acurast.rpcOverrides` | `{}` | Custom RPC endpoints per network |
| `acurast.useKeychainForMnemonic` | `true` | Store mnemonic in OS keychain |

## Commands

All commands are available under the `Acurast` category in the command palette.

| Command | Description |
|---|---|
| Acurast: Init Project | Scaffold `acurast.json` in the workspace |
| Acurast: Deploy | Deploy the active job to the network |
| Acurast: Estimate Cost | Preview ACU cost before deploying |
| Acurast: Choose acurast.json… | Switch active config in a multi-config workspace |
| Acurast: Create Wallet | Generate a new sr25519 wallet |
| Acurast: Import Wallet | Import by mnemonic |
| Acurast: Reveal Mnemonic | Decrypt and show the mnemonic |
| Acurast: Open Dashboard | Open the Acurast web dashboard |

## Development

```bash
npm run build:dev   # build extension + webview with sourcemaps
npm run watch       # watch both bundles in parallel
npm run typecheck   # type-check without emitting
```

Press **F5** in VS Code to launch the Extension Development Host. After code changes, **Cmd+R** reloads the host (webviews don't hot-reload).

Two bundles are produced:

- `dist/extension.js` — Node/CJS host bundle
- `dist/studio/webview.js` — Svelte 5 browser bundle

## License

MIT
