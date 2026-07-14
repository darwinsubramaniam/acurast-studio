import { describe, it, expect, vi, beforeEach } from 'vitest';

// Host-side coverage for the consolidated History delete flow — the one trash
// button on both the Local and On-chain sections. The integration (suite/)
// harness can't import StudioPanel — `@acurast/sdk` is ESM-only and the Mocha
// runtime is CJS, so only esbuild/vitest can load this graph. We mock
// `vscode`, the chain client and the SDK keypair helper, then drive the
// private `history.delete` message handler and assert the guard branches, the
// local-store removal and the loading→ok/error/idle posting contract.

const win = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  showInputBox: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));

const { service, deregisterJob, entries, forceBatch, batchResult } = vi.hoisted(() => {
  const deregisterJob = vi.fn();
  const entries = vi.fn();
  const forceBatch = vi.fn();
  // Mutable holder the forceBatch submittable reads at callback time; tests
  // override `events` to shape per-item ItemCompleted/ItemFailed outcomes
  // (empty → every item succeeded).
  const batchResult: { events: { event: { section: string; method: string; data?: unknown[] } }[] } = { events: [] };
  // Minimal polkadot-js surface for registrationsByLocalId() and the
  // forceBatch submit: each element returned by `entries` decodes into one
  // storedJobRegistration.
  const api = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createType: (type: string, value: any) => {
      if (type === 'u128') return { toNumber: () => value };
      if (type.startsWith('Option<')) {
        return { unwrap: () => ({ toJSON: () => ({ schedule: { startTime: 1, endTime: 2 } }) }) };
      }
      return value; // AcurastCommonMultiOrigin passthrough
    },
    query: { acurast: { storedJobRegistration: { entries } } },
    tx: {
      acurast: { deregister: (id: number) => ({ localId: id }) },
      utility: {
        forceBatch: (calls: unknown[]) => {
          forceBatch(calls);
          return {
            signAndSend: async (_kp: unknown, cb: (r: unknown) => void) => {
              cb({
                status: { isInBlock: true },
                txHash: { toHex: () => '0xbatchhash' },
                dispatchError: undefined,
                events: batchResult.events,
              });
              return () => {};
            },
          };
        },
      },
    },
    registry: { findMetaError: () => ({ section: 'pallet', name: 'Err' }) },
  };
  const service = vi.fn(async () => ({ deregisterJob, connect: async () => api }));
  return { service, deregisterJob, entries, forceBatch, batchResult };
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
let removeRecord: ReturnType<typeof vi.fn>;

function build() {
  getActive = vi.fn(async () => ({ id: 'w1', name: 'Main', address: ORIGIN }));
  reveal = vi.fn(async () => 'correct horse battery staple');
  removeRecord = vi.fn();
  const ctx = { onDidChangeActiveConfig: vi.fn(disposable), configPath: undefined, projectRoot: undefined };
  const wallet = { onDidChange: vi.fn(disposable), getActive, reveal, getActiveId: vi.fn(), list: vi.fn() };
  const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn(disposable) };
  const deploymentStore = { getAll: vi.fn(() => []), remove: removeRecord };
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

function del(over: Record<string, unknown> = {}) {
  return (panel as Any).handle({
    type: 'history.delete',
    id: 'rec1',
    origin: ORIGIN,
    localId: 42,
    network: 'mainnet',
    ...over,
  });
}

const deregPosts = () => posts.filter((p) => p.type === 'deregister.state');

beforeEach(() => {
  vi.clearAllMocks();
  deregisterJob.mockResolvedValue({ toHex: () => '0xfeedface' });
  // Default: the job's registration still exists on-chain under localId 42.
  entries.mockResolvedValue([[{ args: [null, 42] }, {}]]);
  batchResult.events = [];
  vi.mocked(walletFromMnemonic).mockResolvedValue({ address: 'keypair' } as Any);
  build();
});

describe('StudioPanel — history.delete guards', () => {
  it('cancelling the confirm prompt deletes nothing', async () => {
    win.showWarningMessage.mockResolvedValueOnce(undefined); // dismiss confirm
    await del();
    expect(deregPosts()).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
    expect(deregisterJob).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('shows an error and resets to idle when there is no active wallet', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete'); // confirm
    getActive.mockResolvedValueOnce(undefined);
    await del();
    expect(win.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/no active wallet/i));
    expect(deregPosts().map((p) => p.status)).toEqual(['loading', 'idle']);
    expect(reveal).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('aborts on origin/active-wallet mismatch when the user backs out', async () => {
    getActive.mockResolvedValue({ id: 'w1', name: 'Main', address: OTHER });
    win.showWarningMessage
      .mockResolvedValueOnce('Delete') // confirm
      .mockResolvedValueOnce(undefined); // dismiss "Try anyway"
    await del(); // origin ORIGIN ≠ active OTHER
    expect(deregPosts().map((p) => p.status)).toEqual(['loading', 'idle']);
    expect(reveal).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('aborts the whole delete when the password prompt is cancelled', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete'); // confirm (origin matches)
    win.showInputBox.mockResolvedValueOnce(undefined); // cancel password
    await del();
    expect(deregPosts().map((p) => p.status)).toEqual(['loading', 'idle']);
    expect(reveal).not.toHaveBeenCalled();
    expect(deregisterJob).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });
});

describe('StudioPanel — history.delete with a live registration', () => {
  it('deregisters, removes the local record and refreshes history on success', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    win.showInputBox.mockResolvedValueOnce('password123');
    (panel as Any)._route = 'history'; // exercise the post-success pushHistory

    await del();

    const states = deregPosts();
    expect(states.map((p) => p.status)).toEqual(['loading', 'ok']);
    expect(states[1]).toMatchObject({ key: `${ORIGIN}:42`, txHash: '0xfeedface' });
    expect(service).toHaveBeenCalledWith('mainnet');
    expect(deregisterJob).toHaveBeenCalledWith({ address: 'keypair' }, 42);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(removeRecord).toHaveBeenCalledWith('rec1');
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/deregistered/i));
    expect(posts.some((p) => p.type === 'history.state')).toBe(true);
  });

  it('keeps the local record and posts error when the chain submit fails', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    win.showInputBox.mockResolvedValueOnce('password123');
    deregisterJob.mockRejectedValueOnce(new Error('1010: Invalid Transaction'));

    await del();

    const states = deregPosts();
    expect(states.map((p) => p.status)).toEqual(['loading', 'error']);
    expect(states[1]).toMatchObject({ key: `${ORIGIN}:42`, error: '1010: Invalid Transaction' });
    expect(win.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/Deregister failed/i));
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('proceeds through the mismatch warning when the user chooses "Try anyway"', async () => {
    getActive.mockResolvedValue({ id: 'w1', name: 'Main', address: OTHER });
    win.showWarningMessage
      .mockResolvedValueOnce('Delete') // confirm
      .mockResolvedValueOnce('Try anyway'); // proceed despite mismatch
    win.showInputBox.mockResolvedValueOnce('password123');

    await del();

    expect(deregisterJob).toHaveBeenCalledWith({ address: 'keypair' }, 42);
    expect(deregPosts().map((p) => p.status)).toEqual(['loading', 'ok']);
    expect(removeRecord).toHaveBeenCalledWith('rec1');
  });

  it('deregisters without touching the store for an on-chain-only card (no id)', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    win.showInputBox.mockResolvedValueOnce('password123');

    await del({ id: undefined });

    expect(deregisterJob).toHaveBeenCalledWith({ address: 'keypair' }, 42);
    expect(deregPosts().map((p) => p.status)).toEqual(['loading', 'ok']);
    expect(removeRecord).not.toHaveBeenCalled();
  });
});

describe('StudioPanel — history.delete without a live registration', () => {
  it('skips the signing flow and just removes the local record', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    entries.mockResolvedValueOnce([]); // registration already gone from chain

    await del();

    expect(win.showWarningMessage).toHaveBeenCalledTimes(1); // only the confirm
    expect(win.showInputBox).not.toHaveBeenCalled();
    expect(deregisterJob).not.toHaveBeenCalled();
    const states = deregPosts();
    expect(states.map((p) => p.status)).toEqual(['loading', 'ok']);
    expect(states[1]).not.toHaveProperty('txHash');
    expect(removeRecord).toHaveBeenCalledWith('rec1');
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/deleted/i));
  });

  it('removes a record with no job ids without any prompt or chain call', async () => {
    await del({ origin: undefined, localId: undefined });

    expect(win.showWarningMessage).not.toHaveBeenCalled();
    expect(deregPosts()).toHaveLength(0);
    expect(service).not.toHaveBeenCalled();
    expect(removeRecord).toHaveBeenCalledWith('rec1');
    expect(posts.some((p) => p.type === 'history.state')).toBe(true);
  });

  it('offers local-only removal when the chain check fails, and honours a decline', async () => {
    entries.mockRejectedValueOnce(new Error('RPC unreachable'));
    win.showWarningMessage
      .mockResolvedValueOnce('Delete') // confirm
      .mockResolvedValueOnce(undefined); // decline "Delete locally"

    await del();

    expect(deregPosts().map((p) => p.status)).toEqual(['loading', 'idle']);
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('removes locally when the chain check fails and the user accepts', async () => {
    entries.mockRejectedValueOnce(new Error('RPC unreachable'));
    win.showWarningMessage
      .mockResolvedValueOnce('Delete') // confirm
      .mockResolvedValueOnce('Delete locally'); // accept the fallback

    await del();

    expect(deregPosts().map((p) => p.status)).toEqual(['loading', 'ok']);
    expect(deregisterJob).not.toHaveBeenCalled();
    expect(removeRecord).toHaveBeenCalledWith('rec1');
  });

  it('surfaces a chain-check failure as an error for an on-chain-only card', async () => {
    entries.mockRejectedValueOnce(new Error('RPC unreachable'));
    win.showWarningMessage.mockResolvedValueOnce('Delete');

    await del({ id: undefined });

    expect(win.showWarningMessage).toHaveBeenCalledTimes(1); // no local fallback offered
    const states = deregPosts();
    expect(states.map((p) => p.status)).toEqual(['loading', 'error']);
    expect(states[1]).toMatchObject({ error: 'RPC unreachable' });
  });
});

describe('StudioPanel — history.bulkDelete', () => {
  const ITEM_A = { id: 'recA', origin: ORIGIN, localId: 42, network: 'mainnet' };
  const ITEM_B = { id: 'recB', origin: ORIGIN, localId: 43, network: 'mainnet' };

  function bulk(items: Array<Record<string, unknown>>) {
    return (panel as Any).handle({ type: 'history.bulkDelete', items });
  }

  it('cancelling the confirm deletes nothing', async () => {
    win.showWarningMessage.mockResolvedValueOnce(undefined);
    await bulk([ITEM_A, ITEM_B]);
    expect(deregPosts()).toHaveLength(0);
    expect(forceBatch).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('cancelling the password aborts before any state is posted', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    win.showInputBox.mockResolvedValueOnce(undefined);
    await bulk([ITEM_A, ITEM_B]);
    expect(deregPosts()).toHaveLength(0);
    expect(forceBatch).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('submits one forceBatch and removes every record on full success', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    win.showInputBox.mockResolvedValueOnce('password123');
    entries.mockResolvedValueOnce([[{ args: [null, 42] }, {}], [{ args: [null, 43] }, {}]]);
    (panel as Any)._route = 'history';

    await bulk([ITEM_A, ITEM_B]);

    expect(win.showInputBox).toHaveBeenCalledTimes(1); // one password for the whole batch
    expect(forceBatch).toHaveBeenCalledTimes(1);
    expect(forceBatch.mock.calls[0][0]).toHaveLength(2);
    const states = deregPosts();
    expect(states.map((p) => p.status)).toEqual(['loading', 'loading', 'ok', 'ok']);
    expect(states[2]).toMatchObject({ key: `${ORIGIN}:42`, txHash: '0xbatchhash' });
    expect(removeRecord).toHaveBeenCalledWith('recA');
    expect(removeRecord).toHaveBeenCalledWith('recB');
    expect(win.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/deleted 2 deployments/i));
    expect(posts.some((p) => p.type === 'history.state')).toBe(true);
  });

  it('keeps failed items selected-state intact and reports a partial result', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    win.showInputBox.mockResolvedValueOnce('password123');
    entries.mockResolvedValueOnce([[{ args: [null, 42] }, {}], [{ args: [null, 43] }, {}]]);
    batchResult.events = [
      { event: { section: 'utility', method: 'ItemCompleted' } },
      { event: { section: 'utility', method: 'ItemFailed', data: [{ isModule: false, toString: () => 'acurast.CannotDeregister' }] } },
    ];

    await bulk([ITEM_A, ITEM_B]);

    const states = deregPosts();
    expect(states.filter((s) => s.key === `${ORIGIN}:42`).map((s) => s.status)).toEqual(['loading', 'ok']);
    expect(states.filter((s) => s.key === `${ORIGIN}:43`).map((s) => s.status)).toEqual(['loading', 'error']);
    expect(states.find((s) => s.key === `${ORIGIN}:43` && s.status === 'error')).toMatchObject({ error: 'acurast.CannotDeregister' });
    expect(removeRecord).toHaveBeenCalledWith('recA');
    expect(removeRecord).not.toHaveBeenCalledWith('recB');
    expect(win.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/1 failed/i));
  });

  it('skips the batch for items whose registration is already gone', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    win.showInputBox.mockResolvedValueOnce('password123');
    entries.mockResolvedValueOnce([[{ args: [null, 42] }, {}]]); // only 42 still registered

    await bulk([ITEM_A, ITEM_B]);

    expect(forceBatch.mock.calls[0][0]).toHaveLength(1);
    const states = deregPosts();
    expect(states.filter((s) => s.status === 'ok')).toHaveLength(2);
    expect(states.find((s) => s.key === `${ORIGIN}:43` && s.status === 'ok')).not.toHaveProperty('txHash');
    expect(removeRecord).toHaveBeenCalledWith('recA');
    expect(removeRecord).toHaveBeenCalledWith('recB');
  });

  it('removes local-only records without any wallet interaction', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    await bulk([{ id: 'recA' }, { id: 'recB' }]);
    expect(win.showInputBox).not.toHaveBeenCalled();
    expect(getActive).not.toHaveBeenCalled();
    expect(deregPosts()).toHaveLength(0);
    expect(removeRecord).toHaveBeenCalledWith('recA');
    expect(removeRecord).toHaveBeenCalledWith('recB');
  });

  it('warns about foreign-origin jobs and aborts when declined', async () => {
    getActive.mockResolvedValue({ id: 'w1', name: 'Main', address: OTHER });
    win.showWarningMessage
      .mockResolvedValueOnce('Delete') // confirm
      .mockResolvedValueOnce(undefined); // decline foreign-origin warning
    await bulk([ITEM_A]);
    expect(deregPosts()).toHaveLength(0);
    expect(win.showInputBox).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('fails a network group when the chain is unreachable, keeping its records', async () => {
    win.showWarningMessage.mockResolvedValueOnce('Delete');
    win.showInputBox.mockResolvedValueOnce('password123');
    entries.mockRejectedValueOnce(new Error('RPC unreachable'));

    await bulk([ITEM_A, ITEM_B]);

    const states = deregPosts();
    expect(states.map((p) => p.status)).toEqual(['loading', 'loading', 'error', 'error']);
    expect(removeRecord).not.toHaveBeenCalled();
    expect(win.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/2 failed/i));
  });
});
