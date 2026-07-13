// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import InstantMatchProcessors from '../../studio/webview/settings/InstantMatchProcessors.svelte';
import { send } from '../../studio/webview/lib/vscode';
import type { InstantMatchEntry, ManagedProcessor, ProcessorsStateMsg, WalletInfo } from '../../studio/types';

afterEach(() => cleanup());
beforeEach(() => vi.mocked(send).mockReset());

type RenderOpts = {
  activeWallet?: WalletInfo | null;
  processorsState?: ProcessorsStateMsg | null;
};

function renderIM(value: InstantMatchEntry[], opts: RenderOpts = {}) {
  const onChange = vi.fn<(v: InstantMatchEntry[]) => void>();
  render(InstantMatchProcessors, {
    props: {
      value,
      onChange,
      activeWallet: opts.activeWallet ?? null,
      processorsState: opts.processorsState ?? null,
      network: 'mainnet',
    },
  });
  return onChange;
}

const A = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const B = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

function managed(address: string): ManagedProcessor {
  return { address, managerId: '1', lastSeen: 0, advertising: false };
}

describe('InstantMatchProcessors — rendering chosen entries', () => {
  it('renders a card per entry with its own delay value', () => {
    renderIM([
      { processor: A, maxAllowedStartDelayInMs: 5000 },
      { processor: B, maxAllowedStartDelayInMs: 30000 },
    ]);
    // Full address lives on the cell title (display text is truncated).
    expect(screen.getByTitle(A)).toBeInTheDocument();
    expect(screen.getByTitle(B)).toBeInTheDocument();
    // Each entry carries an independent delay input.
    expect(screen.getByDisplayValue('5000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('30000')).toBeInTheDocument();
  });

  it('renders no entries when the list is empty', () => {
    renderIM([]);
    expect(screen.queryByTitle(A)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('gives each entry a labelled Max delay input, an explanatory tooltip, and a Remove button', () => {
    renderIM([{ processor: A, maxAllowedStartDelayInMs: 5000 }]);

    const input = screen.getByLabelText('Max delay (ms)');
    expect(input).toHaveValue(5000);
    expect(input).toHaveAttribute('title', 'Maximum allowed start delay for this processor (ms)');
    expect(screen.getByRole('button', { name: `Remove ${A}` })).toBeInTheDocument();
  });
});

describe('InstantMatchProcessors — removing an entry', () => {
  it('removes just the clicked entry via its × button', async () => {
    const onChange = renderIM([
      { processor: A, maxAllowedStartDelayInMs: 5000 },
      { processor: B, maxAllowedStartDelayInMs: 30000 },
    ]);
    await fireEvent.click(screen.getByRole('button', { name: `Remove ${A}` }));
    expect(onChange).toHaveBeenCalledWith([{ processor: B, maxAllowedStartDelayInMs: 30000 }]);
  });
});

describe('InstantMatchProcessors — editing a per-processor delay', () => {
  it('updates only the edited entry’s delay', async () => {
    const onChange = renderIM([
      { processor: A, maxAllowedStartDelayInMs: 5000 },
      { processor: B, maxAllowedStartDelayInMs: 30000 },
    ]);
    await fireEvent.input(screen.getByDisplayValue('5000'), { target: { value: '12000' } });
    expect(onChange).toHaveBeenCalledWith([
      { processor: A, maxAllowedStartDelayInMs: 12000 },
      { processor: B, maxAllowedStartDelayInMs: 30000 },
    ]);
  });

  it('ignores an invalid (negative / non-numeric) delay', async () => {
    const onChange = renderIM([{ processor: A, maxAllowedStartDelayInMs: 5000 }]);
    await fireEvent.input(screen.getByDisplayValue('5000'), { target: { value: '-5' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('InstantMatchProcessors — manual add', () => {
  it('adds a typed address with the default 10s delay', async () => {
    const onChange = renderIM([]);
    await fireEvent.input(screen.getByPlaceholderText(/add a processor address/i), { target: { value: ` ${A} ` } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onChange).toHaveBeenCalledWith([{ processor: A, maxAllowedStartDelayInMs: 10000 }]);
  });

  it('does not add a duplicate processor', async () => {
    const onChange = renderIM([{ processor: A, maxAllowedStartDelayInMs: 5000 }]);
    await fireEvent.input(screen.getByPlaceholderText(/add a processor address/i), { target: { value: A } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('InstantMatchProcessors — add from "my processors"', () => {
  const wallet: WalletInfo = { id: 'w1', name: 'Main', address: A } as WalletInfo;
  const procState: ProcessorsStateMsg = {
    type: 'processors.state',
    status: 'ok',
    address: A,
    network: 'mainnet',
    result: { managerIds: [], processors: [managed(B)] },
  };

  it('adds a managed processor with the default delay when its row button is clicked', async () => {
    const onChange = renderIM([], { activeWallet: wallet, processorsState: procState });
    // Two "Add" buttons exist: the (disabled) manual-add and the picker row's.
    const enabledAdd = screen
      .getAllByRole('button', { name: 'Add' })
      .find((b) => !(b as HTMLButtonElement).disabled)!;
    await fireEvent.click(enabledAdd);
    expect(onChange).toHaveBeenCalledWith([{ processor: B, maxAllowedStartDelayInMs: 10000 }]);
  });
});
