// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import Deploy from '../../studio/webview/Deploy.svelte';
import { send } from '../../studio/webview/lib/vscode';

afterEach(() => cleanup());
beforeEach(() => vi.mocked(send).mockReset());

function propsFor(over: Record<string, unknown> = {}) {
  return {
    ctx: { isAcurastProject: true },
    deploy: null,
    navigate: vi.fn(),
    pricing: null,
    diagnoses: {},
    symbol: 'ACU',
    ...over,
  };
}

describe('Deploy — Build only button', () => {
  it('sends build.start when clicked in the idle state', async () => {
    render(Deploy, { props: propsFor() });
    await fireEvent.click(screen.getByRole('button', { name: 'Build only' }));
    expect(send).toHaveBeenCalledWith('build.start');
  });

  it('is hidden when no acurast project is active', () => {
    render(Deploy, { props: propsFor({ ctx: { isAcurastProject: false } }) });
    expect(screen.queryByRole('button', { name: 'Build only' })).toBeNull();
  });
});

function deployWith(stages: unknown[]) {
  return {
    active: true,
    startedAt: 1700000000000,
    project: 'demo',
    network: 'mainnet',
    jobIds: [],
    stages,
    chainEvents: [],
    watching: false,
  };
}

describe('Deploy — per-stage logs', () => {
  it('renders active-stage logs color-coded by level', () => {
    const deploy = deployWith([
      {
        id: 'build', label: 'Build artifact', status: 'active', logs: [
          { level: 'info', text: 'compiling', ts: 1 },
          { level: 'error', text: 'boom', ts: 2 },
        ],
      },
    ]);
    const { container } = render(Deploy, { props: propsFor({ deploy }) });
    expect(container.querySelector('.log-info')?.textContent).toBe('compiling');
    expect(container.querySelector('.log-error')?.textContent).toBe('boom');
  });

  it('collapses a completed stage’s logs behind a details summary', () => {
    const deploy = deployWith([
      { id: 'build', label: 'Build artifact', status: 'done', logs: [{ level: 'info', text: 'ok', ts: 1 }] },
      { id: 'bundle', label: 'Package bundle', status: 'active', logs: [] },
    ]);
    const { container } = render(Deploy, { props: propsFor({ deploy }) });
    const details = container.querySelector('details.logdetails');
    expect(details).not.toBeNull();
    expect(details?.querySelector('summary')?.textContent).toContain('1 log line');
  });
});
