// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import Tunnel from '../../studio/webview/tunnel/Tunnel.svelte';
import { send } from '../../studio/webview/lib/vscode';
import type { TunnelStateMsg, TunnelVerifyState } from '../../studio/types';

afterEach(() => cleanup());
beforeEach(() => vi.resetAllMocks());

const WALLETS = {
  list: [
    { id: 'w1', address: '5GrwAlice', publicKey: 'pk1', name: 'Main', description: '' },
    { id: 'w2', address: '5GrwBob', publicKey: 'pk2', name: 'Second', description: '' },
  ],
  activeId: 'w1',
};
const NO_WALLETS = { list: [], activeId: null };

const RELAYS = [
  { host: 'relay-2.canary.acurast.com', ip: '57.129.64.128' },
  { host: 'canary-relay.5elementsnodes.com', ip: '176.9.45.137' },
];
const RELAYS_6 = [
  ...RELAYS,
  { host: 'acurast-canary-relay.dishich.com', ip: '82.154.208.246' },
  { host: 'relay.el9-acurast.com', ip: '213.136.88.18' },
  { host: 'canary-relay.vincent-acurast.xyz', ip: '213.136.90.239' },
  { host: 'canary-relay.acurast.online', ip: '107.172.233.226' },
];

function state(over: Partial<TunnelStateMsg> = {}): TunnelStateMsg {
  return {
    type: 'tunnel.state',
    network: 'canary',
    suffix: 'tunnel.example.com',
    relays: RELAYS,
    wildcardName: '*.tunnel.example.com',
    txtName: '_acu.tunnel.example.com',
    publicUrlExample: 'https://<clientId>.tunnel.example.com:8443',
    port: 8443,
    selectedWalletId: 'w1',
    record: {
      walletId: 'w1',
      name: 'Main',
      address: '5GrwAlice',
      txtValue: 'BASE64VALUE==',
      verified: null,
    },
    verify: { status: 'idle' },
    ...over,
  };
}

/** The host posts these when both records resolve / one is still pending / it errors. */
const DONE_BOTH: TunnelVerifyState = {
  status: 'done',
  wildcard: {
    name: 'acurast-studio-probe.tunnel.example.com',
    expectedIps: ['57.129.64.128'],
    resolvedIps: ['57.129.64.128'],
    ok: true,
  },
  txtFound: ['BASE64VALUE=='],
};
const DONE_PARTIAL: TunnelVerifyState = {
  status: 'done',
  wildcard: {
    name: 'acurast-studio-probe.tunnel.example.com',
    expectedIps: ['57.129.64.128'],
    resolvedIps: ['57.129.64.128'],
    ok: true,
  },
  txtFound: [],
};

function renderTunnel(tunnel: TunnelStateMsg, wallets = WALLETS) {
  const navigate = vi.fn();
  const utils = render(Tunnel, { props: { tunnel, wallets, navigate } });
  return { ...utils, navigate };
}

/** The single status pill lives in the served-at banner (shared StatusPill component). */
const pillText = (c: HTMLElement) => c.querySelector('.status-pill')?.textContent ?? '';

// ── Step seeding ─────────────────────────────────────────────────────────────
describe('step seeding', () => {
  it('starts on Configure when no suffix is set', async () => {
    renderTunnel(state({ suffix: '', wildcardName: '', txtName: '', publicUrlExample: '', record: null }));
    expect(await screen.findByRole('button', { name: /Generate DNS records/i })).toBeInTheDocument();
  });

  it('starts on Records when a suffix is already configured', async () => {
    renderTunnel(state());
    expect(await screen.findByText(/Add these two records at your DNS provider/i)).toBeInTheDocument();
  });

  it('starts on Verify when a check is already in flight', async () => {
    renderTunnel(state({ verify: { status: 'checking' } }));
    expect(await screen.findByText(/Checking DNS…/i)).toBeInTheDocument();
  });
});

// ── Step 1 · Configure ───────────────────────────────────────────────────────
describe('step 1 — configure', () => {
  const empty = () =>
    state({ suffix: '', wildcardName: '', txtName: '', publicUrlExample: '', record: null });

  it('offers a Canary/Mainnet segmented toggle', async () => {
    renderTunnel(empty());
    expect(await screen.findByRole('button', { name: 'Canary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mainnet' })).toBeInTheDocument();
  });

  it('disables Generate until a suffix is entered', async () => {
    renderTunnel(empty());
    expect(await screen.findByRole('button', { name: /Generate DNS records/i })).toBeDisabled();
  });

  it('labels the suffix input for assistive tech', async () => {
    renderTunnel(empty());
    expect(await screen.findByLabelText('Your domain suffix')).toBeInTheDocument();
  });

  it('recomputes immediately when the network segment changes', async () => {
    renderTunnel(empty());
    await fireEvent.click(await screen.findByRole('button', { name: 'Mainnet' }));
    expect(send).toHaveBeenCalledWith('tunnel.compute', { suffix: '', network: 'mainnet', walletId: 'w1' });
  });

  it('advances to Records when Generate is clicked with a suffix', async () => {
    renderTunnel(empty());
    const input = await screen.findByPlaceholderText('tunnel.example.com');
    await fireEvent.input(input, { target: { value: 'my.domain.dev' } });
    await fireEvent.click(screen.getByRole('button', { name: /Generate DNS records/i }));
    // Generate flushes the debounce so records are requested for the entered suffix…
    expect(send).toHaveBeenCalledWith('tunnel.compute', { suffix: 'my.domain.dev', network: 'canary', walletId: 'w1' });
    // …and advances to the Records step.
    expect(await screen.findByText(/Add these two records at your DNS provider/i)).toBeInTheDocument();
  });
});

// ── Step 2 · Records ─────────────────────────────────────────────────────────
describe('step 2 — records', () => {
  it('lists every relay IP for the wildcard A record', async () => {
    renderTunnel(state());
    expect(await screen.findByText('57.129.64.128')).toBeInTheDocument();
    expect(screen.getByText('176.9.45.137')).toBeInTheDocument();
    expect(screen.getByText('*.tunnel.example.com')).toBeInTheDocument();
  });

  it('shows the TXT value and a deployer-wallet selector', async () => {
    renderTunnel(state());
    expect(await screen.findByText('BASE64VALUE==')).toBeInTheDocument();
    expect(screen.getByText('_acu.tunnel.example.com')).toBeInTheDocument();
    const select = screen.getByLabelText('Deployer wallet') as HTMLSelectElement;
    expect(select.value).toBe('w1');
    expect(screen.getByRole('option', { name: /Main \(active\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Second' })).toBeInTheDocument();
  });

  it('badges the records pending/missing before any verification', async () => {
    renderTunnel(state());
    expect(await screen.findByText('pending')).toBeInTheDocument();
    expect(screen.getByText('missing')).toBeInTheDocument();
  });

  it('recomputes for the chosen wallet when the selector changes', async () => {
    renderTunnel(state());
    const select = (await screen.findByLabelText('Deployer wallet')) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'w2' } });
    expect(send).toHaveBeenCalledWith('tunnel.compute', {
      suffix: 'tunnel.example.com',
      network: 'canary',
      walletId: 'w2',
    });
  });

  it('copies the TXT value to the clipboard', async () => {
    renderTunnel(state());
    const copyButtons = await screen.findAllByRole('button', { name: 'Copy' });
    await fireEvent.click(copyButtons[copyButtons.length - 1]); // last Copy = TXT value
    expect(send).toHaveBeenCalledWith('deploy.copy', { text: 'BASE64VALUE==' });
  });

  it('copies all relay IPs at once, newline-separated', async () => {
    renderTunnel(state());
    await fireEvent.click(await screen.findByRole('button', { name: /Copy all/i }));
    expect(send).toHaveBeenCalledWith('deploy.copy', { text: '57.129.64.128\n176.9.45.137' });
  });

  it('starts the DNS check and advances to Verify when Verify DNS is clicked', async () => {
    renderTunnel(state());
    await fireEvent.click(await screen.findByRole('button', { name: /Verify DNS/i }));
    expect(send).toHaveBeenCalledWith('tunnel.verify', {
      suffix: 'tunnel.example.com',
      network: 'canary',
      walletId: 'w1',
    });
  });

  it('collapses extra relay IPs behind a "+N more" expander', async () => {
    renderTunnel(state({ relays: RELAYS_6 }));
    expect(await screen.findByText('82.154.208.246')).toBeInTheDocument(); // 3rd shown
    expect(screen.queryByText('213.136.88.18')).not.toBeInTheDocument(); // 4th hidden
    await fireEvent.click(screen.getByRole('button', { name: /\+3 more relay IPs/i }));
    expect(screen.getByText('213.136.88.18')).toBeInTheDocument();
  });
});

// ── Step 2 edge states ───────────────────────────────────────────────────────
describe('step 2 — no relays', () => {
  const noRelays = () => state({ network: 'mainnet', relays: [] });

  it('explains the empty relay list for the network', async () => {
    renderTunnel(noRelays());
    expect(await screen.findByText(/No relay nodes for Mainnet/i)).toBeInTheDocument();
  });

  it('opens the relay setting', async () => {
    renderTunnel(noRelays());
    await fireEvent.click(await screen.findByRole('button', { name: /Open setting/i }));
    expect(send).toHaveBeenCalledWith('tunnel.openRelaySetting');
  });

  it('offers a one-click switch to Canary', async () => {
    renderTunnel(noRelays());
    await fireEvent.click(await screen.findByRole('button', { name: /Use Canary/i }));
    expect(send).toHaveBeenCalledWith('tunnel.compute', {
      suffix: 'tunnel.example.com',
      network: 'canary',
      walletId: 'w1',
    });
  });

  it('hides the Verify DNS action while blocked', async () => {
    renderTunnel(noRelays());
    await screen.findByText(/No relay nodes for Mainnet/i);
    expect(screen.queryByRole('button', { name: /Verify DNS/i })).not.toBeInTheDocument();
  });
});

describe('step 2 — no wallet', () => {
  const noWallet = () => state({ record: null });

  it('marks the wildcard ready but prompts to add a wallet for the TXT proof', async () => {
    renderTunnel(noWallet(), NO_WALLETS);
    expect(await screen.findByText(/Wildcard A records ready/i)).toBeInTheDocument();
    expect(screen.getByText('No wallet to sign with')).toBeInTheDocument();
  });

  it('routes Create wallet / Import phrase to the Wallets panel', async () => {
    const { navigate } = renderTunnel(noWallet(), NO_WALLETS);
    await fireEvent.click(await screen.findByRole('button', { name: /Create wallet/i }));
    expect(navigate).toHaveBeenCalledWith('wallets');
    await fireEvent.click(screen.getByRole('button', { name: /Import phrase/i }));
    expect(navigate).toHaveBeenCalledWith('wallets');
  });
});

// ── Step 3 · Verify ──────────────────────────────────────────────────────────
describe('step 3 — verifying', () => {
  it('shows both lookups in progress', async () => {
    renderTunnel(state({ verify: { status: 'checking' } }));
    expect(await screen.findByText(/Resolving \*\.tunnel\.example\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/Looking up _acu\.tunnel\.example\.com TXT/i)).toBeInTheDocument();
  });
});

describe('step 3 — done / live', () => {
  const live = () =>
    state({ record: { walletId: 'w1', name: 'Main', address: '5GrwAlice', txtValue: 'BASE64VALUE==', verified: true }, verify: DONE_BOTH });

  it('celebrates a fully verified tunnel', async () => {
    renderTunnel(live());
    expect(await screen.findByText(/Tunnel is live/i)).toBeInTheDocument();
    expect(screen.getByText(/Wildcard resolves to a relay IP/i)).toBeInTheDocument();
    expect(screen.getByText(/TXT for _acu\.tunnel\.example\.com found/i)).toBeInTheDocument();
  });

  it('routes Deploy now to the Deploy panel', async () => {
    const { navigate } = renderTunnel(live());
    await fireEvent.click(await screen.findByRole('button', { name: /Deploy now/i }));
    expect(navigate).toHaveBeenCalledWith('deploy');
  });

  it('re-runs the check from Re-check DNS', async () => {
    renderTunnel(live());
    await fireEvent.click(await screen.findByRole('button', { name: /Re-check DNS/i }));
    expect(send).toHaveBeenCalledWith('tunnel.verify', expect.objectContaining({ suffix: 'tunnel.example.com' }));
  });
});

describe('step 3 — partial propagation', () => {
  const partial = () =>
    state({ record: { walletId: 'w1', name: 'Main', address: '5GrwAlice', txtValue: 'BASE64VALUE==', verified: false }, verify: DONE_PARTIAL });

  it('shows the TXT still pending while the wildcard resolves', async () => {
    renderTunnel(partial());
    expect(await screen.findByText(/TXT not found yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Wildcard resolves/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-check DNS/i })).toBeInTheDocument();
  });
});

describe('step 3 — error', () => {
  const errored = () =>
    state({ verify: { status: 'error', error: 'queryTxt ETIMEOUT _acu.tunnel.example.com' } });

  it('shows the failure with the raw resolver error', async () => {
    renderTunnel(errored());
    expect(await screen.findByText(/DNS lookup failed/i)).toBeInTheDocument();
    expect(screen.getByText('queryTxt ETIMEOUT _acu.tunnel.example.com')).toBeInTheDocument();
  });

  it('retries from Try again', async () => {
    renderTunnel(errored());
    await fireEvent.click(await screen.findByRole('button', { name: /Try again/i }));
    expect(send).toHaveBeenCalledWith('tunnel.verify', expect.objectContaining({ suffix: 'tunnel.example.com' }));
  });
});

// ── Status pill ──────────────────────────────────────────────────────────────
describe('status pill', () => {
  it('reads "Draft" before a suffix exists', async () => {
    const { container } = renderTunnel(state({ suffix: '', wildcardName: '', record: null }));
    await screen.findByRole('button', { name: /Generate DNS records/i });
    expect(pillText(container)).toMatch(/Draft/i);
  });

  it('reads "Records ready" once generated', async () => {
    const { container } = renderTunnel(state());
    await screen.findByText(/Add these two records/i);
    expect(pillText(container)).toMatch(/Records ready/i);
  });

  it('reads "Verifying" while checking', async () => {
    const { container } = renderTunnel(state({ verify: { status: 'checking' } }));
    await screen.findByText(/Checking DNS…/i);
    expect(pillText(container)).toMatch(/Verifying/i);
  });

  it('reads "Live · verified" when both records pass', async () => {
    const { container } = renderTunnel(
      state({ record: { walletId: 'w1', name: 'Main', address: '5GrwAlice', txtValue: 'BASE64VALUE==', verified: true }, verify: DONE_BOTH }),
    );
    await screen.findByText(/Tunnel is live/i);
    expect(pillText(container)).toMatch(/Live/i);
    expect(pillText(container)).toMatch(/verified/i);
  });

  it('reads "Partially verified · 1 of 2 records" when one is pending', async () => {
    const { container } = renderTunnel(
      state({ record: { walletId: 'w1', name: 'Main', address: '5GrwAlice', txtValue: 'BASE64VALUE==', verified: false }, verify: DONE_PARTIAL }),
    );
    await screen.findByText(/TXT not found yet/i);
    expect(pillText(container)).toMatch(/Partially verified .* 1 of 2 records/i);
  });

  it('reads "Verification error" on a lookup failure', async () => {
    const { container } = renderTunnel(state({ verify: { status: 'error', error: 'boom' } }));
    await screen.findByText(/DNS lookup failed/i);
    expect(pillText(container)).toMatch(/Verification error/i);
  });

  it('reads "Blocked" when the network has no relays', async () => {
    const { container } = renderTunnel(state({ network: 'mainnet', relays: [] }));
    await screen.findByText(/No relay nodes for Mainnet/i);
    expect(pillText(container)).toMatch(/Blocked .* no relays for Mainnet/i);
  });

  it('reads "Action needed" when no wallet can sign', async () => {
    const { container } = renderTunnel(state({ record: null }), NO_WALLETS);
    await screen.findByText('No wallet to sign with');
    expect(pillText(container)).toMatch(/Action needed/i);
  });
});

// ── Stepper navigation ───────────────────────────────────────────────────────
describe('stepper', () => {
  it('renders the three steps', async () => {
    renderTunnel(state());
    const stepper = (await screen.findByText(/Add these two records/i)).ownerDocument.querySelector('.stepper') as HTMLElement;
    expect(within(stepper).getByText('Configure')).toBeInTheDocument();
    expect(within(stepper).getByText('Records')).toBeInTheDocument();
    expect(within(stepper).getByText('Verify')).toBeInTheDocument();
  });

  it('jumps back to Configure from the stepper', async () => {
    renderTunnel(state());
    await screen.findByText(/Add these two records/i);
    await fireEvent.click(screen.getByRole('button', { name: /Configure/i }));
    expect(await screen.findByRole('button', { name: /Generate DNS records/i })).toBeInTheDocument();
  });
});
