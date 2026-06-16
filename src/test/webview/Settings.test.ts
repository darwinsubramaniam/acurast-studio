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

// The patch object from the most recent config.save message.
function patchFromLastSave(): Record<string, unknown> {
  const call = vi.mocked(send).mock.calls.find((c) => c[0] === 'config.save');
  if (!call) throw new Error('config.save was not sent');
  return (call[1] as { patch: Record<string, unknown> }).patch;
}

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

// Instant-match lives in the Assignment Strategy accordion section, open by
// default — assignmentStrategy.type defaults to "Single", so the editor shows.
describe('Settings — instant-match processors', () => {
  it('renders stored instant-match entries as table rows with their own delays', () => {
    render(Settings, { props: propsFor({
      ...VALID,
      assignmentStrategy: { type: 'Single', instantMatch: [{ processor: '5aaa', maxAllowedStartDelayInMs: 7000 }] },
    }) });
    expect(screen.getByTitle('5aaa')).toBeInTheDocument();
    expect(screen.getByDisplayValue('7000')).toBeInTheDocument();
  });

  it('saves a newly added processor as a Single instantMatch array (default 10s delay)', async () => {
    render(Settings, { props: propsFor(VALID) });

    // Target the instant-match add field by its section label — the whitelist
    // add field shares the same placeholder. Enter commits the add.
    const input = screen.getByRole('textbox', { name: /Instant Match Processors/i });
    await fireEvent.input(input, { target: { value: '5newproc' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(patchFromLastSave().assignmentStrategy).toMatchObject({
      instantMatch: [{ processor: '5newproc', maxAllowedStartDelayInMs: 10000 }],
    });
  });

  it('drops instantMatch when the only processor is removed (open matching)', async () => {
    render(Settings, { props: propsFor({
      ...VALID,
      assignmentStrategy: { type: 'Single', instantMatch: [{ processor: '5aaa', maxAllowedStartDelayInMs: 7000 }] },
    }) });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove 5aaa' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(patchFromLastSave().assignmentStrategy).toEqual({ type: 'Single' });
  });
});

// The whitelist (now a 2-column table) lives in the collapsed "Advanced" section.
describe('Settings — processor whitelist', () => {
  async function openAdvancedSection() {
    await fireEvent.click(screen.getByText('Advanced'));
  }

  it('renders stored whitelist addresses as table rows', async () => {
    render(Settings, { props: propsFor({ ...VALID, processorWhitelist: ['5wwww'] }) });
    await openAdvancedSection();
    expect(screen.getByTitle('5wwww')).toBeInTheDocument();
  });

  it('saves a newly added whitelist address as an array', async () => {
    render(Settings, { props: propsFor(VALID) });
    await openAdvancedSection();

    // Target the whitelist add field by its section label (shared placeholder
    // with instant match); Enter commits the add.
    const input = screen.getByRole('textbox', { name: /Processor Whitelist/i });
    await fireEvent.input(input, { target: { value: '5wnew' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(patchFromLastSave().processorWhitelist).toEqual(['5wnew']);
  });
});
