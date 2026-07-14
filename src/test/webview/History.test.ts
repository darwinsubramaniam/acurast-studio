// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import History from '../../studio/webview/history/History.svelte';
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

// ── Local section: the consolidated Delete button ────────────────────────────
describe('History — local delete button', () => {
  it.each(['active', 'scheduled', 'expired', 'none', undefined] as const)(
    'shows Delete (and never Deregister) with on-chain status %s',
    (status) => {
      render(History, { props: baseProps({ historyState: localState(status) }) });
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Deregister' })).not.toBeInTheDocument();
    },
  );

  it('sends history.delete with the record id and job info on click', async () => {
    render(History, { props: baseProps({ historyState: localState('active') }) });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(send).toHaveBeenCalledWith('history.delete', {
      id: 'rec1',
      origin: ORIGIN,
      localId: 42,
      network: 'mainnet',
    });
  });

  it('sends only the record id for a record with no job ids', async () => {
    const state: HistoryStateMsg = {
      type: 'history.state',
      status: 'ok',
      records: [localRecord({ jobIds: [] })],
      offset: 0,
      hasMore: false,
      total: 1,
    };
    render(History, { props: baseProps({ historyState: state }) });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(send).toHaveBeenCalledWith('history.delete', { id: 'rec1' });
  });

  it('disables the button while the delete is in flight', () => {
    render(History, {
      props: baseProps({ historyState: localState('active'), deregisters: dereg('loading') }),
    });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('shows the error and keeps the button for retry on failure', () => {
    render(History, {
      props: baseProps({
        historyState: localState('active'),
        deregisters: dereg('error', { error: '1010: Invalid Transaction' }),
      }),
    });
    expect(screen.getByText('1010: Invalid Transaction')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('renders nothing extra for an idle reset (cancelled delete)', () => {
    render(History, {
      props: baseProps({ historyState: localState('active'), deregisters: dereg('idle') }),
    });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});

// ── On-chain section: action + prune ─────────────────────────────────────────
describe('History — on-chain delete', () => {
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

  it('offers Delete on an on-chain card and sends the job info without an id', async () => {
    render(History, { props: onlineProps() });
    // The On-chain accordion is collapsed by default — expand it first.
    await fireEvent.click(screen.getByRole('button', { name: /On-chain/ }));
    expect(screen.getByText('Job #7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deregister' })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(send).toHaveBeenCalledWith('history.delete', {
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

// ── Multi-select bulk delete ──────────────────────────────────────────────────
describe('History — multi-select bulk delete', () => {
  function twoLocalState(): HistoryStateMsg {
    return {
      type: 'history.state',
      status: 'ok',
      records: [
        localRecord(),
        localRecord({ id: 'rec2', jobIds: [{ origin: ORIGIN, localId: 43 }] }),
      ],
      offset: 0,
      hasMore: false,
      total: 2,
      statuses: { rec1: 'active', rec2: 'active' },
    };
  }

  function twoOnlineProps() {
    return {
      historyState: {
        type: 'history.state',
        status: 'ok',
        records: [],
        offset: 0,
        hasMore: false,
        total: 0,
        onlineRecords: [
          onlineRecord(),
          onlineRecord({ id: `online:${ORIGIN}:8`, jobIds: [{ origin: ORIGIN, localId: 8 }] }),
        ],
      } as HistoryStateMsg,
      activeWalletAddress: ORIGIN,
      activeNetwork: 'mainnet',
      diagnoses: {},
      deregisters: {},
      assignments: {},
    };
  }

  it('select-all selects the visible local records and bulk delete sends them all', async () => {
    render(History, { props: baseProps({ historyState: twoLocalState() }) });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Select all local deployments' }));
    const boxes = screen.getAllByRole('checkbox', { name: 'Select deployment' });
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b).toBeChecked();

    await fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
    expect(send).toHaveBeenCalledWith('history.bulkDelete', {
      items: [
        { id: 'rec1', origin: ORIGIN, localId: 42, network: 'mainnet' },
        { id: 'rec2', origin: ORIGIN, localId: 43, network: 'mainnet' },
      ],
    });
  });

  it('unchecking select-all clears the selection and hides the bulk button', async () => {
    render(History, { props: baseProps({ historyState: twoLocalState() }) });
    const all = screen.getByRole('checkbox', { name: 'Select all local deployments' });
    await fireEvent.click(all);
    expect(screen.getByRole('button', { name: 'Delete 2' })).toBeInTheDocument();
    await fireEvent.click(all);
    expect(screen.queryByRole('button', { name: /Delete \d/ })).not.toBeInTheDocument();
  });

  it('selecting one card bulk deletes just that record', async () => {
    render(History, { props: baseProps({ historyState: twoLocalState() }) });
    await fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select deployment' })[0]);
    await fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));
    expect(send).toHaveBeenCalledWith('history.bulkDelete', {
      items: [{ id: 'rec1', origin: ORIGIN, localId: 42, network: 'mainnet' }],
    });
  });

  it('on-chain select-all covers the visible page and bulk deletes without ids', async () => {
    render(History, { props: twoOnlineProps() });
    await fireEvent.click(screen.getByRole('button', { name: /On-chain/ }));
    await fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all visible on-chain deployments' }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
    expect(send).toHaveBeenCalledWith('history.bulkDelete', {
      items: [
        { origin: ORIGIN, localId: 7, network: 'mainnet' },
        { origin: ORIGIN, localId: 8, network: 'mainnet' },
      ],
    });
  });

  it('disables the bulk button while a selected card is deregistering', async () => {
    render(History, {
      props: baseProps({ historyState: twoLocalState(), deregisters: dereg('loading') }),
    });
    // rec1 (origin:42) is loading; select it via select-all.
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Select all local deployments' }));
    expect(screen.getByRole('button', { name: 'Delete 2' })).toBeDisabled();
  });
});
