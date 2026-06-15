// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import History from '../../studio/webview/History.svelte';
import { send } from '../../studio/webview/lib/vscode';
import type {
  HistoryStateMsg,
  StoredDeploymentWithMeta,
  LocalJobStatus,
  DeregisterStateMsg,
  AssignmentsStateMsg,
  OnlineJobRegistration,
} from '../../studio/types';

afterEach(() => cleanup());
beforeEach(() => vi.mocked(send).mockReset());

const ORIGIN = '5Origin';

// ── factories ────────────────────────────────────────────────────────────────
function localRecord(over: Partial<StoredDeploymentWithMeta> = {}): StoredDeploymentWithMeta {
  return {
    id: 'rec1',
    project: 'My Job',
    network: 'mainnet',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_100_000,
    jobIds: [{ origin: ORIGIN, localId: 42 }],
    pathExists: false,
    ...over,
  };
}

function onlineRegistration(over: Partial<OnlineJobRegistration> = {}): OnlineJobRegistration {
  const now = Date.now();
  return {
    startTime: now - 60_000, // already started …
    endTime: now + 3_600_000, // … and not yet expired → 'active'
    intervalMs: '60000',
    durationMs: 1000,
    maxStartDelay: 300_000,
    slots: 1,
    rewardPlanck: '1000000000000',
    strategy: 'Single',
    modules: [],
    scriptUrl: undefined,
    ...over,
  };
}

function onlineRecord(over: Partial<StoredDeploymentWithMeta> = {}): StoredDeploymentWithMeta {
  return {
    id: `online:${ORIGIN}:7`,
    project: 'on-chain',
    network: 'mainnet',
    startedAt: 0,
    finishedAt: 0,
    jobIds: [{ origin: ORIGIN, localId: 7 }],
    pathExists: false,
    registration: onlineRegistration(),
    ...over,
  };
}

/** A `history.state` carrying a single local record plus its resolved status. */
function localState(status: LocalJobStatus | undefined): HistoryStateMsg {
  return {
    type: 'history.state',
    status: 'ok',
    records: [localRecord()],
    offset: 0,
    hasMore: false,
    total: 1,
    ...(status ? { statuses: { rec1: status } } : {}),
  };
}

function dereg(status: DeregisterStateMsg['status'], extra: Partial<DeregisterStateMsg> = {}, key = `${ORIGIN}:42`): Record<string, DeregisterStateMsg> {
  return { [key]: { type: 'deregister.state', key, status, ...extra } };
}

function assign(status: AssignmentsStateMsg['status'], extra: Partial<AssignmentsStateMsg> = {}, key = `${ORIGIN}:7`): Record<string, AssignmentsStateMsg> {
  return { [key]: { type: 'assignments.state', key, status, ...extra } };
}

interface HistoryProps {
  historyState: HistoryStateMsg | null;
  activeWalletAddress: string | null;
  activeNetwork: string;
  diagnoses: Record<string, never>;
  deregisters: Record<string, DeregisterStateMsg>;
  assignments: Record<string, AssignmentsStateMsg>;
}

function baseProps(over: Partial<HistoryProps> = {}): HistoryProps {
  return {
    historyState: localState('active'),
    activeWalletAddress: ORIGIN,
    activeNetwork: 'mainnet',
    diagnoses: {},
    deregisters: {},
    assignments: {},
    ...over,
  };
}

// ── Local section: when the Deregister action is offered ─────────────────────
describe('History — local deregister gating', () => {
  it('offers Deregister for a running (active) job', () => {
    render(History, { props: baseProps({ historyState: localState('active') }) });
    expect(screen.getByRole('button', { name: 'Deregister' })).toBeInTheDocument();
  });

  it('offers Deregister for a scheduled (not-yet-started) job', () => {
    render(History, { props: baseProps({ historyState: localState('scheduled') }) });
    expect(screen.getByRole('button', { name: 'Deregister' })).toBeInTheDocument();
  });

  it('hides Deregister for an expired job', () => {
    render(History, { props: baseProps({ historyState: localState('expired') }) });
    expect(screen.queryByRole('button', { name: 'Deregister' })).not.toBeInTheDocument();
  });

  it('hides Deregister when the job is no longer on-chain (none)', () => {
    render(History, { props: baseProps({ historyState: localState('none') }) });
    expect(screen.queryByRole('button', { name: 'Deregister' })).not.toBeInTheDocument();
  });

  it('hides Deregister until the on-chain status has resolved', () => {
    // No `statuses` → the record's status stays "loading" → not deregisterable yet.
    render(History, { props: baseProps({ historyState: localState(undefined) }) });
    expect(screen.queryByRole('button', { name: 'Deregister' })).not.toBeInTheDocument();
  });
});

// ── Local section: action + progress states ──────────────────────────────────
describe('History — local deregister flow', () => {
  it('sends history.deregister with origin, localId and network on click', async () => {
    render(History, { props: baseProps({ historyState: localState('active') }) });
    await fireEvent.click(screen.getByRole('button', { name: 'Deregister' }));
    expect(send).toHaveBeenCalledWith('history.deregister', {
      origin: ORIGIN,
      localId: 42,
      network: 'mainnet',
    });
  });

  it('disables the button and shows a spinner while deregistering', () => {
    render(History, {
      props: baseProps({ historyState: localState('active'), deregisters: dereg('loading') }),
    });
    const btn = screen.getByRole('button', { name: /Deregistering/ });
    expect(btn).toBeDisabled();
  });

  it('shows a "Deregistered" badge and tx hash, and removes the button, on success', () => {
    render(History, {
      props: baseProps({
        historyState: localState('active'),
        deregisters: dereg('ok', { txHash: '0xdeadbeefcafebabe1234567890' }),
      }),
    });
    expect(screen.getByText('Deregistered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deregister' })).not.toBeInTheDocument();
    expect(screen.getByText(/tx 0xdeadbeef/)).toBeInTheDocument();
  });

  it('shows the error and keeps the button for retry on failure', () => {
    render(History, {
      props: baseProps({
        historyState: localState('active'),
        deregisters: dereg('error', { error: '1010: Invalid Transaction' }),
      }),
    });
    expect(screen.getByText('1010: Invalid Transaction')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deregister' })).toBeInTheDocument();
  });
});

// ── On-chain section: action + prune ─────────────────────────────────────────
describe('History — on-chain deregister', () => {
  function onlineProps(
    deregisters: Record<string, DeregisterStateMsg> = {},
    assignments: Record<string, AssignmentsStateMsg> = {},
  ) {
    return {
      historyState: {
        type: 'history.state',
        status: 'ok',
        records: [],
        offset: 0,
        hasMore: false,
        total: 0,
        onlineRecords: [onlineRecord()],
      } as HistoryStateMsg,
      activeWalletAddress: ORIGIN,
      activeNetwork: 'mainnet',
      diagnoses: {},
      deregisters,
      assignments,
    };
  }

  it('offers Deregister on an active on-chain card and sends the right payload', async () => {
    render(History, { props: onlineProps() });
    // The On-chain accordion is collapsed by default — expand it first.
    await fireEvent.click(screen.getByRole('button', { name: /On-chain/ }));
    expect(screen.getByText('Job #7')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Deregister' }));
    expect(send).toHaveBeenCalledWith('history.deregister', {
      origin: ORIGIN,
      localId: 7,
      network: 'mainnet',
    });
  });

  it('prunes a deregistered job from the on-chain list', async () => {
    render(History, {
      props: onlineProps(dereg('ok', { txHash: '0xabc0000000' }, `${ORIGIN}:7`)),
    });
    await fireEvent.click(screen.getByRole('button', { name: /On-chain/ }));
    expect(screen.queryByText('Job #7')).not.toBeInTheDocument();
    expect(screen.getByText(/No additional on-chain deployments found/i)).toBeInTheDocument();
  });
});

// ── On-chain section: per-processor start times ──────────────────────────────
describe('History — on-chain processor start times', () => {
  function onlineProps(
    deregisters: Record<string, DeregisterStateMsg> = {},
    assignments: Record<string, AssignmentsStateMsg> = {},
  ) {
    return {
      historyState: {
        type: 'history.state',
        status: 'ok',
        records: [],
        offset: 0,
        hasMore: false,
        total: 0,
        onlineRecords: [onlineRecord()],
      } as HistoryStateMsg,
      activeWalletAddress: ORIGIN,
      activeNetwork: 'mainnet',
      diagnoses: {},
      deregisters,
      assignments,
    };
  }

  it('sends history.fetchAssignments when "Start times" is clicked', async () => {
    render(History, { props: onlineProps() });
    await fireEvent.click(screen.getByRole('button', { name: /On-chain/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Start times' }));
    expect(send).toHaveBeenCalledWith('history.fetchAssignments', {
      origin: ORIGIN,
      localId: 7,
      network: 'mainnet',
    });
  });

  it('renders each processor with its actual start (startTime + startDelay)', async () => {
    const assignments = assign('ok', {
      processors: [{ address: '5Proc', slot: 0, startDelay: 90_000, acknowledged: true }],
    });
    render(History, { props: onlineProps({}, assignments) });
    await fireEvent.click(screen.getByRole('button', { name: /On-chain/ }));
    // The processor address and its assigned stagger delay are shown.
    expect(screen.getByText('5Proc')).toBeInTheDocument();
    expect(screen.getByText(/starts/)).toBeInTheDocument();
    // The button flips to a refresh affordance once a result is present.
    expect(screen.getByRole('button', { name: 'Refresh start times' })).toBeInTheDocument();
  });
});
