// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: mockSend,
}));

import App from '../../studio/webview/App.svelte';
import { ICONS } from '../../studio/webview/lib/icons';

function dispatch(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

beforeEach(() => vi.resetAllMocks());

describe('App bootstrap', () => {
  it('sends "ready" on mount', () => {
    render(App);
    expect(mockSend).toHaveBeenCalledWith('ready');
  });

  it('renders the Home route by default', () => {
    render(App);
    // The Home route is the only one with the donation footer.
    expect(screen.getByText('Support development')).toBeInTheDocument();
  });
});

describe('message: route', () => {
  it('switches to wallets route on "route" message', async () => {
    render(App);
    await tick();
    dispatch({ type: 'route', route: 'wallets' });
    await tick();
    expect(screen.getByRole('heading', { name: 'Wallets' })).toBeInTheDocument();
  });

  it('switches back to home route', async () => {
    render(App);
    await tick();
    dispatch({ type: 'route', route: 'wallets' });
    await tick();
    dispatch({ type: 'route', route: 'home' });
    await tick();
    expect(screen.getByText('Support development')).toBeInTheDocument();
  });

  it('titles the settings route "Project Settings" with the {} (braces) icon', async () => {
    const { container } = render(App);
    await tick();
    dispatch({ type: 'route', route: 'settings' });
    await tick();
    expect(screen.getByRole('heading', { name: 'Project Settings' })).toBeInTheDocument();
    // Positively assert the braces ({}) icon is the one rendered in the route header.
    // Normalize both through the same parser so attribute order/whitespace match.
    const expected = document.createElement('span');
    expected.innerHTML = ICONS.braces;
    expect(container.querySelector('.title-icon')?.innerHTML).toBe(expected.innerHTML);
  });
});

describe('message: context', () => {
  it('updates project context and reflects it in the Home view', async () => {
    render(App);
    await tick();
    dispatch({
      type: 'context',
      isAcurastProject: true,
      configPath: '/ws/acurast.json',
      configRel: 'acurast.json',
      configExists: true,
      anyConfigExists: true,
    });
    await tick();
    expect(screen.getByText('acurast.json')).toBeInTheDocument();
  });
});

describe('message: wallets.state', () => {
  it('updates wallet subtitle when wallet list is received', async () => {
    render(App);
    await tick();
    dispatch({
      type: 'wallets.state',
      wallets: [{ id: '1', address: '5Grw', publicKey: 'pk', name: 'Main', description: '' }],
      activeId: '1',
      network: 'mainnet',
      symbol: 'ACU',
    });
    await tick();
    expect(screen.getByText(/1 wallet/)).toBeInTheDocument();
  });
});

describe('message: deploy.state', () => {
  it('shows last deploy succeeded message after successful deploy', async () => {
    render(App);
    await tick();
    dispatch({
      type: 'deploy.state',
      state: { active: false, result: 'ok', project: 'my-job', stages: [] },
    });
    await tick();
    expect(screen.getByText(/Last deploy succeeded/)).toBeInTheDocument();
  });
});
