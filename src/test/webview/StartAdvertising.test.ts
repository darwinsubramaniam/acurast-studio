// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import Processors from '../../studio/webview/processors/Processors.svelte';
import { send } from '../../studio/webview/lib/vscode';
import type { ManagedProcessor, ProcessorsStateMsg, WalletInfo } from '../../studio/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => vi.mocked(send).mockReset());

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

const MGR = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const PROC_A = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const PROC_B = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

const wallet = { id: 'w1', name: 'Main', address: MGR } as WalletInfo;

function proc(address: string, over: Partial<ManagedProcessor> = {}): ManagedProcessor {
  return { address, managerId: '7', lastSeen: 0, advertising: false, ...over };
}

function renderProcessors(processors: ManagedProcessor[]) {
  const processorsState: ProcessorsStateMsg = {
    type: 'processors.state',
    status: 'ok',
    address: MGR,
    network: 'canary',
    result: { managerIds: ['7'], processors },
  };
  render(Processors, {
    props: {
      wallets: { list: [wallet], activeId: 'w1', network: 'canary', symbol: 'cACU' },
      processorsState,
    },
  });
}

describe('Processors — Start advertising entry point', () => {
  it('offers "Start advertising" (and no module editor) on a non-advertising processor', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderProcessors([proc(PROC_A)]);

    expect(screen.getByText('Not currently advertising on the marketplace.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start advertising' })).toBeInTheDocument();
    // The edit-modules apply button belongs to the advertising branch only.
    expect(screen.queryByRole('button', { name: 'Apply on-chain' })).not.toBeInTheDocument();
  });

  it('opens the form with pricing/capacity fields when clicked', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderProcessors([proc(PROC_A)]);

    await fireEvent.click(screen.getByRole('button', { name: 'Start advertising' }));

    expect(screen.getByLabelText('Fee / ms (planck)')).toHaveValue('1');
    expect(screen.getByLabelText('Fee / byte (planck)')).toHaveValue('1');
    expect(screen.getByLabelText('Base fee / run (planck)')).toHaveValue('0');
    expect(screen.getByLabelText('Available for (days)')).toHaveValue(30);
    expect(screen.getByLabelText('Max memory (bytes)')).toHaveValue(100_000_000);
    expect(screen.getByLabelText('Storage (bytes)')).toHaveValue(100_000_000);
    expect(screen.getByLabelText('Net quota')).toHaveValue(100);
    expect(screen.getByRole('button', { name: 'Advertise on-chain' })).toBeEnabled();
  });

  it('Cancel closes the form and brings the entry button back', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderProcessors([proc(PROC_A)]);

    await fireEvent.click(screen.getByRole('button', { name: 'Start advertising' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Fee / ms (planck)')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start advertising' })).toBeInTheDocument();
  });
});

describe('Processors — Start advertising submit', () => {
  it('sends processors.advertise with the full newAd payload', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderProcessors([proc(PROC_A)]);

    await fireEvent.click(screen.getByRole('button', { name: 'Start advertising' }));
    await fireEvent.click(screen.getByRole('button', { name: /LLM/ }));
    await fireEvent.input(screen.getByLabelText('Fee / ms (planck)'), { target: { value: '9' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Advertise on-chain' }));

    expect(send).toHaveBeenCalledWith('processors.advertise', {
      walletId: 'w1',
      processor: PROC_A,
      modules: ['LLM'],
      network: 'canary',
      newAd: {
        feePerMillisecond: '9',
        feePerStorageByte: '1',
        baseFeePerExecution: '0',
        schedulingWindowEnd: NOW + 30 * DAY,
        maxMemory: 100_000_000,
        storageCapacity: 100_000_000,
        networkRequestQuota: 100,
      },
    });
  });

  it('disables submit while a fee is not an unsigned-integer planck string', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderProcessors([proc(PROC_A)]);

    await fireEvent.click(screen.getByRole('button', { name: 'Start advertising' }));
    await fireEvent.input(screen.getByLabelText('Fee / ms (planck)'), { target: { value: '1.5' } });

    expect(screen.getByRole('button', { name: 'Advertise on-chain' })).toBeDisabled();

    await fireEvent.input(screen.getByLabelText('Fee / ms (planck)'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Advertise on-chain' })).toBeEnabled();
  });
});

describe('Processors — Start advertising prefill', () => {
  it('copies pricing/capacities from an advertising sibling when one exists', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderProcessors([
      proc(PROC_A),
      proc(PROC_B, {
        advertising: true,
        ad: {
          maxMemory: 250_000_000,
          networkRequestQuota: 50,
          storageCapacity: 75_000_000,
          availableModules: ['LLM'],
          allowedConsumers: null,
        },
        pricing: {
          feePerMillisecond: '9',
          feePerStorageByte: '3',
          baseFeePerExecution: '2000000000',
          schedulingWindowEnd: NOW + 90 * DAY,
        },
      }),
    ]);

    // Only the non-advertising card offers the entry button.
    const starts = screen.getAllByRole('button', { name: 'Start advertising' });
    expect(starts).toHaveLength(1);
    await fireEvent.click(starts[0]);

    expect(screen.getByLabelText('Fee / ms (planck)')).toHaveValue('9');
    expect(screen.getByLabelText('Fee / byte (planck)')).toHaveValue('3');
    expect(screen.getByLabelText('Base fee / run (planck)')).toHaveValue('2000000000');
    expect(screen.getByLabelText('Max memory (bytes)')).toHaveValue(250_000_000);
    expect(screen.getByLabelText('Storage (bytes)')).toHaveValue(75_000_000);
    expect(screen.getByLabelText('Net quota')).toHaveValue(50);
  });
});
