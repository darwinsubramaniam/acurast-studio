// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import Tunnel from '../../studio/webview/Tunnel.svelte';
import { send } from '../../studio/webview/lib/vscode';
import type { TunnelStateMsg } from '../../studio/types';

afterEach(() => cleanup());
beforeEach(() => vi.resetAllMocks());

const WALLETS = {
  list: [
    { id: 'w1', address: '5GrwAlice', publicKey: 'pk1', name: 'Main', description: '' },
    { id: 'w2', address: '5GrwBob', publicKey: 'pk2', name: 'Second', description: '' },
  ],
  activeId: 'w1',
};

function state(over: Partial<TunnelStateMsg> = {}): TunnelStateMsg {
  return {
    type: 'tunnel.state',
    network: 'canary',
    suffix: 'tunnel.example.com',
    relays: [
      { host: 'relay-2.canary.acurast.com', ip: '57.129.64.128' },
      { host: 'canary-relay.5elementsnodes.com', ip: '176.9.45.137' },
    ],
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

describe('empty states', () => {
  it('prompts for a suffix when none is set', () => {
    const empty = state({
      suffix: '',
      wildcardName: '',
      txtName: '',
      publicUrlExample: '',
      record: null,
    });
    render(Tunnel, { props: { tunnel: empty, wallets: WALLETS } });
    expect(screen.getByText(/Enter a domain suffix above to generate records/i)).toBeInTheDocument();
  });
});

describe('record rendering', () => {
  it('lists every relay IP for the wildcard record', () => {
    render(Tunnel, { props: { tunnel: state(), wallets: WALLETS } });
    expect(screen.getByText('57.129.64.128')).toBeInTheDocument();
    expect(screen.getByText('176.9.45.137')).toBeInTheDocument();
    // The wildcard name appears in both the note and the Name row.
    expect(screen.getAllByText('*.tunnel.example.com').length).toBeGreaterThan(0);
  });

  it('shows the TXT record for the selected wallet only', () => {
    render(Tunnel, { props: { tunnel: state(), wallets: WALLETS } });
    expect(screen.getAllByText('_acu.tunnel.example.com').length).toBeGreaterThan(0);
    expect(screen.getByText('BASE64VALUE==')).toBeInTheDocument();
    // Only the selected wallet's record (address) is rendered; the other wallet
    // is offered in the switcher but its record is not shown.
    expect(screen.getByText('5GrwAlice')).toBeInTheDocument();
    expect(screen.queryByText('5GrwBob')).not.toBeInTheDocument();
  });

  it('offers a deployer wallet selector with the active wallet marked', () => {
    render(Tunnel, { props: { tunnel: state(), wallets: WALLETS } });
    const select = screen.getByLabelText('Deployer wallet') as HTMLSelectElement;
    expect(select.value).toBe('w1');
    expect(screen.getByRole('option', { name: /Main \(active\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Second' })).toBeInTheDocument();
  });

  it('shows the relay empty-state when the network has no relays', () => {
    render(Tunnel, { props: { tunnel: state({ relays: [] }), wallets: WALLETS } });
    expect(screen.getByText(/No relay nodes are configured/i)).toBeInTheDocument();
  });

  it('shows the no-wallets empty-state when there are none', () => {
    render(Tunnel, { props: { tunnel: state({ record: null }), wallets: { list: [], activeId: null } } });
    expect(screen.getByText(/Create or import a wallet to generate a TXT record/i)).toBeInTheDocument();
  });
});

describe('messages to the host', () => {
  it('recomputes for the chosen wallet when the selector changes', async () => {
    render(Tunnel, { props: { tunnel: state(), wallets: WALLETS } });
    const select = screen.getByLabelText('Deployer wallet') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'w2' } });
    expect(send).toHaveBeenCalledWith('tunnel.compute', {
      suffix: 'tunnel.example.com',
      network: 'canary',
      walletId: 'w2',
    });
  });

  it('recomputes when the network changes', async () => {
    render(Tunnel, { props: { tunnel: state(), wallets: WALLETS } });
    const select = screen.getByLabelText('Network') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'mainnet' } });
    expect(send).toHaveBeenCalledWith('tunnel.compute', {
      suffix: 'tunnel.example.com',
      network: 'mainnet',
      walletId: 'w1',
    });
  });

  it('verifies only the selected wallet', async () => {
    render(Tunnel, { props: { tunnel: state(), wallets: WALLETS } });
    await fireEvent.click(screen.getByRole('button', { name: /Check DNS/i }));
    expect(send).toHaveBeenCalledWith('tunnel.verify', {
      suffix: 'tunnel.example.com',
      network: 'canary',
      walletId: 'w1',
    });
  });

  it('copies the TXT value to the clipboard', async () => {
    render(Tunnel, { props: { tunnel: state(), wallets: WALLETS } });
    const copyButtons = screen.getAllByRole('button', { name: 'Copy' });
    // The last Copy button belongs to the TXT value row.
    await fireEvent.click(copyButtons[copyButtons.length - 1]);
    expect(send).toHaveBeenCalledWith('deploy.copy', { text: 'BASE64VALUE==' });
  });
});

describe('verification results', () => {
  it('shows verified marks when the selected wallet TXT is found', () => {
    const verified = state({
      record: {
        walletId: 'w1',
        name: 'Main',
        address: '5GrwAlice',
        txtValue: 'BASE64VALUE==',
        verified: true,
      },
      verify: {
        status: 'done',
        wildcard: {
          name: 'acurast-studio-probe.tunnel.example.com',
          expectedIps: ['57.129.64.128'],
          resolvedIps: ['57.129.64.128'],
          ok: true,
        },
        txtFound: ['BASE64VALUE=='],
      },
    });
    render(Tunnel, { props: { tunnel: verified, wallets: WALLETS } });
    expect(screen.getByText('verified')).toBeInTheDocument();
    expect(screen.getByText(/TXT for Main found\./i)).toBeInTheDocument();
    expect(screen.getByText(/Wildcard resolves to a relay IP/i)).toBeInTheDocument();
  });

  it('shows a missing badge when the TXT is not found', () => {
    const missing = state({
      record: {
        walletId: 'w1',
        name: 'Main',
        address: '5GrwAlice',
        txtValue: 'BASE64VALUE==',
        verified: false,
      },
      verify: {
        status: 'done',
        wildcard: {
          name: 'acurast-studio-probe.tunnel.example.com',
          expectedIps: ['57.129.64.128'],
          resolvedIps: [],
          ok: false,
        },
        txtFound: [],
      },
    });
    render(Tunnel, { props: { tunnel: missing, wallets: WALLETS } });
    expect(screen.getByText('missing')).toBeInTheDocument();
    expect(screen.getByText(/TXT for Main not found\./i)).toBeInTheDocument();
  });
});
