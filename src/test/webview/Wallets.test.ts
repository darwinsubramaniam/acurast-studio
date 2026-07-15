// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import Wallets from '../../studio/webview/wallets/Wallets.svelte';
import type { BalanceMsg } from '../../studio/types';

afterEach(() => cleanup());
beforeEach(() => vi.resetAllMocks());

const WALLET = { id: 'w1', address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', publicKey: 'pk1', name: 'Main', description: '' };
const WALLET2 = { id: 'w2', address: '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy', publicKey: 'pk2', name: 'Deploy Key', description: '' };
const WALLET3 = { id: 'w3', address: '5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX', publicKey: 'pk3', name: 'Canary Test', description: '' };

const WALLETS_CANARY = { list: [WALLET], activeId: 'w1', network: 'canary', symbol: 'cACU' };
const WALLETS_MAINNET = { list: [WALLET], activeId: 'w1', network: 'mainnet', symbol: 'ACU' };

const BAL_ZERO: BalanceMsg = { status: 'ok', value: 0, symbol: 'cACU' };
const BAL_NONZERO: BalanceMsg = { status: 'ok', value: 1.5, symbol: 'cACU' };
const BAL_LOADING: BalanceMsg = { status: 'loading' };
const BAL_ERROR: BalanceMsg = { status: 'error', message: 'Connection failed' };

/** Build the per-wallet balances map keyed by the active wallet id. */
const bal = (b: BalanceMsg, id = 'w1') => ({ [id]: b });

// ---------------------------------------------------------------------------

describe('no-funds nudge — canary network', () => {
  it('shows the nudge when the active wallet balance is 0', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: bal(BAL_ZERO), walletOp: null } });
    expect(screen.getByText(/No funds yet/)).toBeInTheDocument();
  });

  it('links to the canary faucet', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: bal(BAL_ZERO), walletOp: null } });
    const link = screen.getByRole('link', { name: /Acurast Faucet/i });
    expect(link).toHaveAttribute('href', 'https://faucet.acurast.com/');
  });
});

// ---------------------------------------------------------------------------

describe('no-funds nudge — mainnet', () => {
  it('shows the nudge when the active wallet balance is 0', () => {
    render(Wallets, { props: { wallets: WALLETS_MAINNET, walletBalances: bal({ ...BAL_ZERO, symbol: 'ACU' }), walletOp: null } });
    expect(screen.getByText(/No funds yet/)).toBeInTheDocument();
  });

  it('links to the ACU docs page', () => {
    render(Wallets, { props: { wallets: WALLETS_MAINNET, walletBalances: bal({ ...BAL_ZERO, symbol: 'ACU' }), walletOp: null } });
    const link = screen.getByRole('link', { name: /get ACU/i });
    expect(link).toHaveAttribute('href', 'https://docs.acurast.com/token-holders/how-to-get-acu/');
  });

  it('does not show a faucet link', () => {
    render(Wallets, { props: { wallets: WALLETS_MAINNET, walletBalances: bal({ ...BAL_ZERO, symbol: 'ACU' }), walletOp: null } });
    expect(screen.queryByRole('link', { name: /faucet/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('no-funds nudge — hidden cases', () => {
  it('does not show when balance is positive', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: bal(BAL_NONZERO), walletOp: null } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });

  it('does not show while balance is loading', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: bal(BAL_LOADING), walletOp: null } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });

  it('does not show before the first balance fetch (no entry)', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: {}, walletOp: null } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });

  it('does not show when the balance fetch errored', () => {
    render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: bal(BAL_ERROR), walletOp: null } });
    expect(screen.queryByText(/No funds yet/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('active card balance states', () => {
  it('shows a spinner while the balance is loading', () => {
    const { container } = render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: bal(BAL_LOADING), walletOp: null } });
    expect(container.querySelector('.spinner')).toBeInTheDocument();
  });

  it('shows a spinner before the first balance fetch (no entry)', () => {
    const { container } = render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: {}, walletOp: null } });
    expect(container.querySelector('.spinner')).toBeInTheDocument();
  });

  it('shows the value and no spinner once the balance resolves', () => {
    const { container } = render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: bal(BAL_NONZERO), walletOp: null } });
    expect(container.querySelector('.spinner')).not.toBeInTheDocument();
    expect(screen.getByText('1.50')).toBeInTheDocument();
  });

  it('shows "Balance unavailable" and no spinner when the fetch fails', () => {
    const { container } = render(Wallets, { props: { wallets: WALLETS_CANARY, walletBalances: bal(BAL_ERROR), walletOp: null } });
    expect(container.querySelector('.spinner')).not.toBeInTheDocument();
    expect(screen.getByText('Balance unavailable')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('all-wallets list', () => {
  it('renders a row with the balance for a non-active wallet', () => {
    const wallets = { list: [WALLET, WALLET2], activeId: 'w1', network: 'canary', symbol: 'cACU' };
    render(Wallets, { props: { wallets, walletBalances: { w1: BAL_NONZERO, w2: { status: 'ok', value: 4.2, symbol: 'cACU' } }, walletOp: null } });
    expect(screen.getByText('Deploy Key')).toBeInTheDocument();
    expect(screen.getByText(/4\.20 cACU/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set active/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

// A non-active wallet with a zero balance shows a funding link in its row. The
// label follows the target network — mainnet has no faucet, so it must read
// "Learn how to get ACU" (docs) there, not "Faucet". Scope to `.wallet-row` so
// the queries hit the non-active row, not the active card's own funding link.
describe('no-funds nudge — non-active wallet rows', () => {
  const balances = { w1: BAL_NONZERO, w2: { status: 'ok', value: 0, symbol: 'cACU' } as BalanceMsg };

  it('labels the row link "Learn how to get ACU" (docs) on mainnet', () => {
    const wallets = { list: [WALLET, WALLET2], activeId: 'w1', network: 'mainnet', symbol: 'ACU' };
    const { container } = render(Wallets, { props: { wallets, walletBalances: balances, walletOp: null } });
    const link = container.querySelector('.wallet-row .wr-link');
    expect(link).toHaveTextContent('Learn how to get ACU');
    expect(link).not.toHaveTextContent(/Faucet/i);
    expect(link).toHaveAttribute('href', 'https://docs.acurast.com/token-holders/how-to-get-acu/');
  });

  it('labels the row link "Faucet" on canary', () => {
    const wallets = { list: [WALLET, WALLET2], activeId: 'w1', network: 'canary', symbol: 'cACU' };
    const { container } = render(Wallets, { props: { wallets, walletBalances: balances, walletOp: null } });
    const link = container.querySelector('.wallet-row .wr-link');
    expect(link).toHaveTextContent('Faucet');
    expect(link).toHaveAttribute('href', 'https://faucet.acurast.com/');
  });
});

// ---------------------------------------------------------------------------

describe('wallet search', () => {
  const wallets = { list: [WALLET, WALLET2, WALLET3], activeId: 'w1', network: 'canary', symbol: 'cACU' };
  const balances = {
    w1: BAL_NONZERO,
    w2: { status: 'ok', value: 4.2, symbol: 'cACU' } as BalanceMsg,
    w3: BAL_ZERO,
  };

  it('shows a search bar once there are 2+ other wallets', () => {
    render(Wallets, { props: { wallets, walletBalances: balances, walletOp: null } });
    expect(screen.getByPlaceholderText(/search wallets by name/i)).toBeInTheDocument();
  });

  it('hides the search bar when there is only one other wallet', () => {
    const two = { list: [WALLET, WALLET2], activeId: 'w1', network: 'canary', symbol: 'cACU' };
    render(Wallets, { props: { wallets: two, walletBalances: balances, walletOp: null } });
    expect(screen.queryByPlaceholderText(/search wallets by name/i)).not.toBeInTheDocument();
  });

  it('filters the other wallets but keeps the active wallet in view', async () => {
    render(Wallets, { props: { wallets, walletBalances: balances, walletOp: null } });
    await fireEvent.input(screen.getByPlaceholderText(/search wallets by name/i), { target: { value: 'deploy' } });
    expect(screen.getByText('Deploy Key')).toBeInTheDocument();
    expect(screen.queryByText('Canary Test')).not.toBeInTheDocument();
    // The active wallet is never affected by the search.
    expect(screen.getByText('Main')).toBeInTheDocument();
  });

  it('shows a no-match message but keeps the active wallet when nothing matches', async () => {
    render(Wallets, { props: { wallets, walletBalances: balances, walletOp: null } });
    await fireEvent.input(screen.getByPlaceholderText(/search wallets by name/i), { target: { value: 'zzz' } });
    expect(screen.getByText(/No wallets match/i)).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
  });
});

describe('empty wallet list', () => {
  it('shows create/import prompts when no wallets exist', () => {
    render(Wallets, { props: { wallets: { list: [], activeId: null, network: 'canary', symbol: 'cACU' }, walletBalances: {}, walletOp: null } });
    expect(screen.getByRole('button', { name: /Create New Wallet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import Existing/i })).toBeInTheDocument();
  });
});
