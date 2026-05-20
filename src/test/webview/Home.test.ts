// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import Home from '../../studio/webview/Home.svelte';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

const BASE_CTX = {
  isAcurastProject: true,
  configPath: '/workspace/acurast.json',
  configRel: 'acurast.json',
  configExists: true,
  anyConfigExists: true,
};

const BASE_WALLETS = { list: [], activeId: null, network: 'mainnet', symbol: 'ACU' };

beforeEach(() => vi.resetAllMocks());

// ---------------------------------------------------------------------------

describe('walletSub subtitle', () => {
  it('shows "Create or import to begin" when no wallets exist', () => {
    render(Home, { props: { ctx: BASE_CTX, wallets: { list: [], activeId: null }, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText('Create or import to begin')).toBeInTheDocument();
  });

  it('shows singular "1 wallet" when one wallet exists', () => {
    const w = { id: '1', address: '5Grw', publicKey: 'pk', name: 'Main', description: '' };
    render(Home, { props: { ctx: BASE_CTX, wallets: { list: [w], activeId: null }, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText(/1 wallet/)).toBeInTheDocument();
  });

  it('shows plural "2 wallets" when two wallets exist', () => {
    const w = (id: string) => ({ id, address: '5Grw', publicKey: 'pk', name: 'W', description: '' });
    render(Home, { props: { ctx: BASE_CTX, wallets: { list: [w('1'), w('2')], activeId: null }, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText(/2 wallets/)).toBeInTheDocument();
  });

  it('appends "• active set" when an active wallet is selected', () => {
    const w = { id: '1', address: '5Grw', publicKey: 'pk', name: 'Main', description: '' };
    render(Home, { props: { ctx: BASE_CTX, wallets: { list: [w], activeId: '1' }, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText(/active set/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('projectSub subtitle', () => {
  it('shows config relative path when project is valid', () => {
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText('acurast.json')).toBeInTheDocument();
  });

  it('shows init hint when not an acurast project and no config exists', () => {
    const ctx = { isAcurastProject: false, configPath: null, configRel: null, configExists: false, anyConfigExists: false };
    render(Home, { props: { ctx, wallets: BASE_WALLETS, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText(/acurast:init project/)).toBeInTheDocument();
  });

  it('shows "No acurast.json selected" when not a project but configs exist', () => {
    const ctx = { isAcurastProject: false, configPath: null, configRel: null, configExists: false, anyConfigExists: true };
    render(Home, { props: { ctx, wallets: BASE_WALLETS, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText('No acurast.json selected')).toBeInTheDocument();
  });

  it('shows missing-file warning when project is set but config file is gone', () => {
    const ctx = { ...BASE_CTX, configExists: false };
    render(Home, { props: { ctx, wallets: BASE_WALLETS, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('deploySub subtitle', () => {
  it('shows "No deployments yet" when deploy is null', () => {
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: null, navigate: vi.fn() } });
    expect(screen.getByText('No deployments yet')).toBeInTheDocument();
  });

  it('shows running stage label when deployment is active', () => {
    const deploy = { active: true, result: null, project: null, stages: [{ id: 'upload', label: 'Upload to IPFS', status: 'active' }] };
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: deploy as any, navigate: vi.fn() } });
    expect(screen.getByText(/Upload to IPFS/)).toBeInTheDocument();
  });

  it('shows "Last deploy succeeded" when result is ok', () => {
    const deploy = { active: false, result: 'ok', project: 'my-job', stages: [] };
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: deploy as any, navigate: vi.fn() } });
    expect(screen.getByText(/Last deploy succeeded/)).toBeInTheDocument();
  });

  it('shows "Last deploy failed" when result is error', () => {
    const deploy = { active: false, result: 'error', project: null, stages: [] };
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: deploy as any, navigate: vi.fn() } });
    expect(screen.getByText('Last deploy failed')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('Project Settings button', () => {
  it('is enabled when project is valid', () => {
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: null, navigate: vi.fn() } });
    const btn = screen.getByRole('button', { name: /Project Settings/i });
    expect(btn).not.toBeDisabled();
  });

  it('is disabled when not an acurast project', () => {
    const ctx = { ...BASE_CTX, isAcurastProject: false, anyConfigExists: false, configExists: false };
    render(Home, { props: { ctx, wallets: BASE_WALLETS, deploy: null, navigate: vi.fn() } });
    expect(screen.getByRole('button', { name: /Project Settings/i })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------

describe('navigation', () => {
  it('calls navigate("wallets") when Wallets card is clicked', async () => {
    const navigate = vi.fn();
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: null, navigate } });
    await fireEvent.click(screen.getByRole('button', { name: /Wallets/i }));
    expect(navigate).toHaveBeenCalledWith('wallets');
  });

  it('calls navigate("settings") when Project Settings card is clicked', async () => {
    const navigate = vi.fn();
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: null, navigate } });
    await fireEvent.click(screen.getByRole('button', { name: /Project Settings/i }));
    expect(navigate).toHaveBeenCalledWith('settings');
  });

  it('calls navigate("deploy") when Deployments card is clicked', async () => {
    const navigate = vi.fn();
    render(Home, { props: { ctx: BASE_CTX, wallets: BASE_WALLETS, deploy: null, navigate } });
    await fireEvent.click(screen.getByRole('button', { name: /Deployments/i }));
    expect(navigate).toHaveBeenCalledWith('deploy');
  });
});
