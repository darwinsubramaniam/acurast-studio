import { describe, it, expect, vi, beforeEach } from 'vitest';

// Host-side coverage for the History-view deregister flow. The integration
// (suite/) harness can't import StudioPanel — `@acurast/sdk` is ESM-only and the
// Mocha runtime is CJS, so only esbuild/vitest can load this graph. We mock
// `vscode`, the chain client and the SDK keypair helper, then drive the private
// `history.deregister` message handler and assert the guard branches and the
// loading→ok/error posting contract.

const win = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  showInputBox: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));

const { service, deregisterJob } = vi.hoisted(() => {
  const deregisterJob = vi.fn();
  return { deregisterJob, service: vi.fn(async () => ({ deregisterJob })) };
});

const { disposable } = vi.hoisted(() => ({ disposable: () => ({ dispose() {} }) }));

vi.mock('vscode', () => ({
  window: win,
  workspace: {
    onDidSaveTextDocument: vi.fn(disposable),
    onDidChangeConfiguration: vi.fn(disposable),
    getConfiguration: vi.fn(() => ({ get: (_k: string, d?: unknown) => d })),
  },
  commands: { executeCommand: vi.fn() },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

vi.mock('../../sdk/acurastClient', () => ({ acurastClient: { service } }));
vi.mock('../../sdk/pricing', () => ({ loadPricing: vi.fn() }));
vi.mock('@acurast/sdk/chain', () => ({
  walletFromMnemonic: vi.fn(async () => ({ address: 'keypair' })),
  getAcknowledgedProcessors: vi.fn(),
  jobIdFromChainJson: vi.fn(),
}));
vi.mock('@acurast/sdk/deploy', () => ({ loadAcurastConfig: vi.fn() }));
vi.mock('@acurast/sdk/matcher', () => ({ toCacu: vi.fn() }));

import { StudioPanel } from '../../studio/studioPanel';
import { walletFromMnemonic } from '@acurast/sdk/chain';

const ORIGIN = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let panel: StudioPanel;
let posts: Array<Record<string, unknown>>;
let getActive: ReturnType<typeof vi.fn>;
let reveal: ReturnType<typeof vi.fn>;

function build() {
  getActive = vi.fn(async () => ({ id: 'w1', name: 'Main', address: ORIGIN }));
  reveal = vi.fn(async () => 'correct horse battery staple');
  const ctx = { onDidChangeActiveConfig: vi.fn(disposable), configPath: undefined, projectRoot: undefined };
  const wallet = { onDidChange: vi.fn(disposable), getActive, reveal, getActiveId: vi.fn(), list: vi.fn() };
  const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn(disposable) };
  const deploymentStore = { getAll: vi.fn(() => []) };
  const workspaceState = { get: vi.fn(), update: vi.fn(), keys: vi.fn(() => []) };

  panel = new StudioPanel(
    { fsPath: '/ext' } as Any,
    ctx as Any,
    wallet as Any,
    secrets as Any,
    deploymentStore as Any,
    workspaceState as Any
  );
  posts = [];
  (panel as Any)._view = { webview: { postMessage: (m: Record<string, unknown>) => posts.push(m) } };
}

function deregister(origin = ORIGIN, localId = 42, network = 'mainnet') {
  return (panel as Any).handle({ type: 'history.deregister', origin, localId, network });
}

const deregPosts = () => posts.filter((p) => p.type === 'deregister.state');

beforeEach(() => {
  vi.clearAllMocks();
  service.mockImplementation(async () => ({ deregisterJob }));
  deregisterJob.mockResolvedValue({ toHex: () => '0xfeedface' });
  vi.mocked(walletFromMnemonic).mockResolvedValue({ address: 'keypair' } as Any);
  build();
});

describe('StudioPanel — history.deregister guards', () => {
  it('cancelling the confirm prompt deregisters nothing', async () => {
    win.showWarningMessage.mockResolvedValueOnce(undefined); // dismiss confirm
    await deregister();
    expect(deregPosts()).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
    expect(deregisterJob).not.toHaveBeenCalled();
  });

  it('shows an error and posts nothing when there is no active wallet', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Deregister'); // confirm
    getActive.mockResolvedValueOnce(undefined);
    await deregister();
    expect(win.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/no active wallet/i));
    expect(deregPosts()).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('aborts on origin/active-wallet mismatch when the user backs out', async () => {
    getActive.mockResolvedValue({ id: 'w1', name: 'Main', address: OTHER });
    win.showWarningMessage
      .mockResolvedValueOnce('Deregister') // confirm
      .mockResolvedValueOnce(undefined); // dismiss "Try anyway"
    await deregister(); // origin ORIGIN ≠ active OTHER
    expect(deregPosts()).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('does not submit when the password prompt is cancelled', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Deregister'); // confirm (origin matches)
    win.showInputBox.mockResolvedValueOnce(undefined); // cancel password
    await deregister();
    expect(deregPosts()).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
    expect(deregisterJob).not.toHaveBeenCalled();
  });
});

describe('StudioPanel — history.deregister submission', () => {
  it('posts loading then ok with the tx hash and refreshes history on success', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Deregister');
    win.showInputBox.mockResolvedValueOnce('password123');
    (panel as Any)._route = 'history'; // exercise the post-success pushHistory

    await deregister();

    const states = deregPosts();
    expect(states.map((p) => p.status)).toEqual(['loading', 'ok']);
    expect(states[1]).toMatchObject({ key: `${ORIGIN}:42`, txHash: '0xfeedface' });
    expect(service).toHaveBeenCalledWith('mainnet');
    expect(deregisterJob).toHaveBeenCalledWith({ address: 'keypair' }, 42);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/deregistered/i));
    expect(posts.some((p) => p.type === 'history.state')).toBe(true);
  });

  it('posts loading then error when the chain submit fails', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Deregister');
    win.showInputBox.mockResolvedValueOnce('password123');
    deregisterJob.mockRejectedValueOnce(new Error('1010: Invalid Transaction'));

    await deregister();

    const states = deregPosts();
    expect(states.map((p) => p.status)).toEqual(['loading', 'error']);
    expect(states[1]).toMatchObject({ key: `${ORIGIN}:42`, error: '1010: Invalid Transaction' });
    expect(win.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/Deregister failed/i));
  });

  it('proceeds through the mismatch warning when the user chooses "Try anyway"', async () => {
    getActive.mockResolvedValue({ id: 'w1', name: 'Main', address: OTHER });
    win.showWarningMessage
      .mockResolvedValueOnce('Deregister') // confirm
      .mockResolvedValueOnce('Try anyway'); // proceed despite mismatch
    win.showInputBox.mockResolvedValueOnce('password123');

    await deregister();

    expect(deregisterJob).toHaveBeenCalledWith({ address: 'keypair' }, 42);
    expect(deregPosts().map((p) => p.status)).toEqual(['loading', 'ok']);
  });
});
