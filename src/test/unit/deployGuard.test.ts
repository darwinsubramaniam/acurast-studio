import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// End-to-end guard test for the deploy flow: the unit tests around `resolveAgainst`
// prove the helper throws, this proves `deploy()` is actually wired to it and aborts
// *before* the confirm dialog, the password prompt and any SDK call. A regression
// that dropped the try/catch would still pass the helper tests but fail here.

const { deployProjectMock, loadAcurastConfigMock, walletFromMnemonicMock, convertConfigToJobMock } = vi.hoisted(() => ({
  deployProjectMock: vi.fn(),
  loadAcurastConfigMock: vi.fn(),
  walletFromMnemonicMock: vi.fn(),
  convertConfigToJobMock: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),          // the confirm dialog — undefined = user cancels
    showInformationMessage: vi.fn(),
    showInputBox: vi.fn(),                // the password prompt
    withProgress: vi.fn(),
  },
  workspace: { isTrusted: true, getConfiguration: () => ({ get: () => undefined }) },
  ProgressLocation: { Notification: 15 },
}));
vi.mock('@acurast/sdk/deploy', () => ({
  deployProject: deployProjectMock,
  loadAcurastConfig: loadAcurastConfigMock,
}));
vi.mock('@acurast/sdk/chain', () => ({
  walletFromMnemonic: walletFromMnemonicMock,
  convertConfigToJob: convertConfigToJobMock,
}));

import * as vscode from 'vscode';
import { deploy } from '../../commands/deploy';

// Mirrors fixtures/demo-workspace/acurast.json — schema-valid so `validateDeployConfig`
// doesn't abort first and hand us a false "blocked".
const baseConfig = {
  projectName: 'demo',
  fileUrl: 'index.js',
  network: 'mainnet',
  onlyAttestedDevices: true,
  assignmentStrategy: { type: 'Single' },
  execution: { type: 'onetime', maxExecutionTimeInMs: 300000 },
  maxAllowedStartDelayInMs: 10000,
  usageLimit: { maxMemory: 0, maxNetworkRequests: 0, maxStorage: 0 },
  numberOfReplicas: 1,
  requiredModules: [],
  minProcessorReputation: 0,
  maxCostPerExecution: 100000000000,
  includeEnvironmentVariables: [],
  processorWhitelist: [],
};

let tmp: string;
let projectRoot: string;
let configPath: string;
const revealMock = vi.fn();

function runDeploy(fileUrl: string) {
  loadAcurastConfigMock.mockReturnValue({ ...baseConfig, fileUrl });
  fs.writeFileSync(configPath, JSON.stringify({ projects: { demo: { ...baseConfig, fileUrl } } }));
  return deploy({
    ctx: { configPath, projectRoot } as never,
    wallet: { getActive: async () => ({ id: 'w1', name: 'test' }), reveal: revealMock } as never,
    output: { clear: vi.fn(), show: vi.fn(), appendLine: vi.fn() } as never,
    studioPanel: { beginDeploy: vi.fn(), endDeploy: vi.fn(), appendDeployLog: vi.fn(), recordDeployStatus: vi.fn() } as never,
  });
}

/** Nothing was read, signed or uploaded — and the user was never even asked. */
function expectAbortedBeforeAnyWork() {
  expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  expect(revealMock).not.toHaveBeenCalled();
  expect(deployProjectMock).not.toHaveBeenCalled();
}

const errorMessages = () => vi.mocked(vscode.window.showErrorMessage).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-deploy-guard-'));
  projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  configPath = path.join(projectRoot, 'acurast.json');
  fs.writeFileSync(path.join(projectRoot, 'index.js'), 'console.log(1)');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'ssh-rsa AAAA…');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('deploy() containment guard', () => {
  it('aborts on a traversal fileUrl without prompting or calling the SDK', async () => {
    await runDeploy('../../../../etc/passwd');
    expect(errorMessages().join('\n')).toMatch(/outside the project directory/);
    expectAbortedBeforeAnyWork();
  });

  it('aborts on an absolute fileUrl pointing elsewhere on disk', async () => {
    await runDeploy('/etc/passwd');
    expect(errorMessages().join('\n')).toMatch(/outside the project directory/);
    expectAbortedBeforeAnyWork();
  });

  it('aborts on a symlink inside the project that points outside it', async () => {
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(projectRoot, 'payload.js'));
    await runDeploy('payload.js');
    expect(errorMessages().join('\n')).toMatch(/outside the project directory/);
    expectAbortedBeforeAnyWork();
  });

  // Positive control. Without this the tests above prove nothing — every one of them
  // would still "pass" if deploy() were broken and aborted on every input.
  it('lets a contained fileUrl reach the confirm dialog', async () => {
    await runDeploy('index.js');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Deploy "demo" to mainnet\?/),
      expect.anything(),
      'Deploy',
    );
    // Confirm mock returns undefined → user cancelled → still no signing.
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(deployProjectMock).not.toHaveBeenCalled();
  });

  it('lets a remote ipfs:// reference reach the confirm dialog', async () => {
    await runDeploy('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});
