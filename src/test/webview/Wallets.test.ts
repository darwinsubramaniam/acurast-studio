// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import Wallets from '../../studio/webview/Wallets.svelte';
import type { BalanceMsg } from '../../studio/types';

afterEach(() => cleanup());
beforeEach(() => vi.resetAllMocks());

const WALLET = { id: 'w1', address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', publicKey: 'pk1', name: 'Main', description: '' };

const WALLETS_CANARY = { list: [WALLET], activeId: 'w1', network: 'canary', symbol: 'cACU' };
const WALLETS_MAINNET = { list: [WALLET], activeId: 'w1', network: 'mainnet', symbol: 'ACU' };

const BAL_ZERO: BalanceMsg = { status: 'ok', value: 0, symbol: 'cACU' };
const BAL_NONZERO: BalanceMsg = { status: 'ok', value: 1.5, symbol: 'cACU' };
const BAL_LOADING: BalanceMsg = { status: 'loading' };
const BAL_IDLE: BalanceMsg = { status: 'idle' };
const BAL_ERROR: BalanceMsg = { status: 'error', message: 'Connection failed' };

// ---------------------------------------------------------------------------

describe('no-funds banner — canary network', () => {
  it('shows banner when active wallet balance is 0', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, balance: BAL_ZERO } });
    expect(screen.getByText(/No funds yet/)).toBeInTheDocument();
  });

  it('shows cACU token name in the banner', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, balance: BAL_ZERO } });
    expect(screen.getByText('cACU', { selector: 'strong' })).toBeInTheDocument();
  });

  it('links to the faucet', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, balance: BAL_ZERO } });
    const link = screen.getByRole('link', { name: /Acurast Faucet/i });
    expect(link).toHaveAttribute('href', 'https://faucet.acurast.com/');
  });
});

// ---------------------------------------------------------------------------

describe('no-funds banner — mainnet', () => {
  it('shows banner when active wallet balance is 0', () => {
    render(Wallets, { props: { wallets: WALLETS_MAINNET, balance: { ...BAL_ZERO, symbol: 'ACU' } } });
    expect(screen.getByText(/No funds yet/)).toBeInTheDocument();
  });

  it('links to the ACU docs page', () => {
    render(Wallets, { props: { wallets: WALLETS_MAINNET, balance: { ...BAL_ZERO, symbol: 'ACU' } } });
    const link = screen.getByRole('link', { name: /get ACU/i });
    expect(link).toHaveAttribute('href', 'https://docs.acurast.com/token-holders/how-to-get-acu/');
  });

  it('does not show the faucet link', () => {
    render(Wallets, { props: { wallets: WALLETS_MAINNET, balance: { ...BAL_ZERO, symbol: 'ACU' } } });
    expect(screen.queryByRole('link', { name: /faucet/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('no-funds banner — hidden cases', () => {
  it('does not show when balance is positive', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, balance: BAL_NONZERO } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });

  it('does not show while balance is loading', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, balance: BAL_LOADING } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });

  it('does not show when balance is idle', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, balance: BAL_IDLE } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });

  it('does not show when balance fetch errored', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, balance: BAL_ERROR } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });

  it('does not show when the wallet is not the active one', () => {
    const wallets = { ...WALLETS_CANARY, activeId: 'other' };
    render(Wallets, { props: { wallets, balance: BAL_ZERO } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('empty wallet list', () => {
  it('shows create/import prompts when no wallets exist', () => {
    render(Wallets, { props: { wallets: { list: [], activeId: null, network: 'canary', symbol: 'cACU' }, balance: BAL_IDLE } });
    expect(screen.getByRole('button', { name: /Create New Wallet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import Existing/i })).toBeInTheDocument();
  });
});
