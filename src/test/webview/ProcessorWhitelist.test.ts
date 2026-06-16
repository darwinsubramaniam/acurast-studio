// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import ProcessorWhitelist from '../../studio/webview/settings/ProcessorWhitelist.svelte';
import { send } from '../../studio/webview/lib/vscode';
import type { ManagedProcessor, ProcessorsStateMsg, WalletInfo } from '../../studio/types';

afterEach(() => cleanup());
beforeEach(() => vi.mocked(send).mockReset());

type RenderOpts = {
  activeWallet?: WalletInfo | null;
  processorsState?: ProcessorsStateMsg | null;
};

function renderWL(value: string, opts: RenderOpts = {}) {
  const onChange = vi.fn<(v: string) => void>();
  render(ProcessorWhitelist, {
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

describe('ProcessorWhitelist — table rendering', () => {
  it('renders a row per whitelisted address', () => {
    renderWL(`${A}\n${B}`);
    expect(screen.getByTitle(A)).toBeInTheDocument();
    expect(screen.getByTitle(B)).toBeInTheDocument();
  });

  it('has exactly two columns (Processor, Remove) and no Max Delay column', () => {
    renderWL(A);
    expect(screen.getByRole('columnheader', { name: 'Processor' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Max Delay/i })).not.toBeInTheDocument();
  });

  it('renders no table when the whitelist is empty', () => {
    renderWL('');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('ProcessorWhitelist — editing', () => {
  it('removes the clicked address, emitting the newline-joined remainder', async () => {
    const onChange = renderWL(`${A}\n${B}`);
    await fireEvent.click(screen.getByRole('button', { name: `Remove ${A}` }));
    expect(onChange).toHaveBeenCalledWith(B);
  });

  it('adds a typed address via the manual field', async () => {
    const onChange = renderWL('');
    await fireEvent.input(screen.getByPlaceholderText(/add a processor address/i), { target: { value: ` ${A} ` } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onChange).toHaveBeenCalledWith(A);
  });

  it('does not add a duplicate address', async () => {
    const onChange = renderWL(A);
    await fireEvent.input(screen.getByPlaceholderText(/add a processor address/i), { target: { value: A } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ProcessorWhitelist — add from "my processors"', () => {
  const wallet: WalletInfo = { id: 'w1', name: 'Main', address: A } as WalletInfo;
  const procState: ProcessorsStateMsg = {
    type: 'processors.state',
    status: 'ok',
    address: A,
    network: 'mainnet',
    result: { managerIds: [], processors: [managed(B)] },
  };

  it('whitelists a managed processor when its row button is clicked', async () => {
    const onChange = renderWL('', { activeWallet: wallet, processorsState: procState });
    const enabledAdd = screen
      .getAllByRole('button', { name: 'Add' })
      .find((b) => !(b as HTMLButtonElement).disabled)!;
    await fireEvent.click(enabledAdd);
    expect(onChange).toHaveBeenCalledWith(B);
  });
});
