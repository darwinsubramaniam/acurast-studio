// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../studio/webview/lib/vscode', () => ({
  vscode: { postMessage: vi.fn() },
  send: vi.fn(),
}));

import Settings from '../../studio/webview/settings/Settings.svelte';
import { send } from '../../studio/webview/lib/vscode';

afterEach(() => cleanup());
beforeEach(() => vi.mocked(send).mockReset());

// Minimal props for Settings. The project must carry projectName + fileUrl so the
// `errors` validation passes and the "Save Changes" button is enabled once dirty.
function propsFor(project: Record<string, unknown>) {
  return {
    ctx: { configPath: '/proj/acurast.json', configRel: 'acurast.json' },
    config: { data: { projects: { demo: project } }, projectKey: 'demo' },
    navigate: vi.fn(),
    pricing: null,
    fiatList: null,
    fiatSelection: null,
    wallets: { list: [], activeId: null, network: 'mainnet' },
    processorsState: null,
  };
}

const VALID = { projectName: 'demo', fileUrl: './index.js' };

// The env-vars input lives in the (collapsed) "Advanced" accordion section.
async function openAdvanced() {
  await fireEvent.click(screen.getByText('Advanced'));
  return (await screen.findByLabelText(/Include env vars/i)) as HTMLInputElement;
}

describe('Settings — includeEnvironmentVariables field', () => {
  it('renders the stored whitelist as a comma-joined string', async () => {
    render(Settings, { props: propsFor({ ...VALID, includeEnvironmentVariables: ['EXISTING', 'TWO'] }) });
    const input = await openAdvanced();
    expect(input.value).toBe('EXISTING,TWO');
  });

  it('shows an empty field when no whitelist is set', async () => {
    render(Settings, { props: propsFor(VALID) });
    const input = await openAdvanced();
    expect(input.value).toBe('');
  });

  it('parses comma-separated input into a trimmed, gap-free array on save', async () => {
    render(Settings, { props: propsFor(VALID) });
    const input = await openAdvanced();

    await fireEvent.input(input, { target: { value: 'FOO, BAR , ,BAZ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(send).toHaveBeenCalledWith('config.save', {
      projectKey: 'demo',
      patch: expect.objectContaining({ includeEnvironmentVariables: ['FOO', 'BAR', 'BAZ'] }),
    });
  });

  it('emits an empty array when the field is cleared', async () => {
    render(Settings, { props: propsFor({ ...VALID, includeEnvironmentVariables: ['ONLY'] }) });
    const input = await openAdvanced();

    await fireEvent.input(input, { target: { value: '   ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(send).toHaveBeenCalledWith('config.save', {
      projectKey: 'demo',
      patch: expect.objectContaining({ includeEnvironmentVariables: [] }),
    });
  });
});

// The build fields live in the (collapsed) "Build" accordion section.
async function openBuild() {
  await fireEvent.click(screen.getByText('Build'));
  return (await screen.findByLabelText(/Build command/i)) as HTMLInputElement;
}

describe('Settings — build section', () => {
  it('renders the stored build fields', async () => {
    render(Settings, { props: propsFor({ ...VALID, build: { command: 'npm run build', cwd: 'app', output: 'dist/index.js' } }) });
    const cmd = await openBuild();
    expect(cmd.value).toBe('npm run build');
    expect((screen.getByLabelText(/Working directory/i) as HTMLInputElement).value).toBe('app');
    expect((screen.getByLabelText(/Output artifact/i) as HTMLInputElement).value).toBe('dist/index.js');
  });

  it('saves a build.command edit as a nested build object', async () => {
    render(Settings, { props: propsFor(VALID) });
    const cmd = await openBuild();

    await fireEvent.input(cmd, { target: { value: 'cargo build --release' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(send).toHaveBeenCalledWith('config.save', {
      projectKey: 'demo',
      patch: expect.objectContaining({ build: expect.objectContaining({ command: 'cargo build --release' }) }),
    });
  });

  it('preserves sibling build fields when editing only the command', async () => {
    render(Settings, { props: propsFor({ ...VALID, build: { command: 'old', cwd: 'app', output: 'dist/index.js' } }) });
    const cmd = await openBuild();

    await fireEvent.input(cmd, { target: { value: 'new' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(send).toHaveBeenCalledWith('config.save', {
      projectKey: 'demo',
      patch: expect.objectContaining({ build: { command: 'new', cwd: 'app', output: 'dist/index.js' } }),
    });
  });
});
