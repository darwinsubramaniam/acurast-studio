import { describe, it, expect, vi, beforeEach } from 'vitest';

// Host-side coverage for the Tunnel DNS panel's `tunnel.openRelaySetting` message
// (the No-Relays edge state's "Open setting" button). Same constraint as the other
// StudioPanel unit tests: `@acurast/sdk` is ESM-only, so only esbuild/vitest can
// load this graph. We mock `vscode` (capturing `commands.executeCommand`), build a
// StudioPanel with stub services, then drive its private `handle()` dispatcher.

const cmd = vi.hoisted(() => ({ executeCommand: vi.fn() }));
const { disposable } = vi.hoisted(() => ({ disposable: () => ({ dispose() {} }) }));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  workspace: {
    onDidSaveTextDocument: vi.fn(disposable),
    onDidChangeConfiguration: vi.fn(disposable),
    getConfiguration: vi.fn(() => ({ get: (_k: string, d?: unknown) => d })),
  },
  commands: cmd,
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

vi.mock('../../sdk/acurastClient', () => ({ acurastClient: { service: vi.fn() } }));
vi.mock('../../sdk/pricing', () => ({ loadPricing: vi.fn() }));
vi.mock('@acurast/sdk/chain', () => ({
  walletFromMnemonic: vi.fn(),
  getAcknowledgedProcessors: vi.fn(),
  jobIdFromChainJson: vi.fn(),
}));
vi.mock('@acurast/sdk/deploy', () => ({ loadAcurastConfig: vi.fn() }));
vi.mock('@acurast/sdk/matcher', () => ({ toCacu: vi.fn() }));

import { StudioPanel } from '../../studio/studioPanel';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let panel: StudioPanel;

function build() {
  const ctx = { onDidChangeActiveConfig: vi.fn(disposable), configPath: undefined, projectRoot: undefined };
  const wallet = { onDidChange: vi.fn(disposable), getActive: vi.fn(), getActiveId: vi.fn(), list: vi.fn() };
  const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn(disposable) };
  const deploymentStore = { getAll: vi.fn(() => []) };
  const workspaceState = { get: vi.fn(), update: vi.fn(), keys: vi.fn(() => []) };

  panel = new StudioPanel(
    { fsPath: '/ext' } as Any,
    ctx as Any,
    wallet as Any,
    secrets as Any,
    deploymentStore as Any,
    workspaceState as Any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  build();
});

describe('StudioPanel — tunnel.openRelaySetting', () => {
  it('opens the Settings UI focused on the acurast.tunnelRelays override', async () => {
    await (panel as Any).handle({ type: 'tunnel.openRelaySetting' });
    expect(cmd.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'acurast.tunnelRelays');
  });
});
