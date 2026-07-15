import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// End-to-end coverage of the pre-deploy config gate, in a live VS Code host.
//
// Deploy (src/commands/deploy.ts) and Estimate (src/commands/estimateCost.ts)
// share one helper — src/sdk/validateDeployConfig.ts — that runs the SDK's zod
// schema over the on-disk acurast.json and splits BLOCKING errors from advisory
// NOTES. This drives that exact `file → loadAcurastConfig → validateConfig`
// pipeline against real files in the extension-host runtime, so the whole
// contract the two commands depend on is proven end-to-end (not just in Vitest).
//
// Two workarounds, both matching existing suite conventions:
//  1. @acurast/sdk is ESM-only — it exposes no `require` condition, so a CJS
//     `require()` throws ERR_PACKAGE_PATH_NOT_EXPORTED, and tsc(CommonJS) even
//     downlevels a normal `import()` to `require`, which fails the same way. We
//     therefore reach the *real* SDK via a Function-constructed dynamic import
//     that tsc leaves untouched — proving the CJS↔ESM interop works in the actual
//     VS Code host, not just under Vitest.
//  2. validateDeployConfig itself can't be imported here for the same ESM reason,
//     so `classify()` mirrors its errors/notes split exactly — the same way
//     instantMatch.test.ts's `saveLikeHost` mirrors StudioPanel.saveConfigPatch.

// Genuine runtime ESM import from CJS: tsc can't see through `new Function`, so it
// stays a real dynamic `import()` instead of being downleveled to `require`.
const importESM = new Function('p', 'return import(p)') as (p: string) => Promise<Record<string, unknown>>;

interface IssueLike { path?: (string | number)[]; message: string; }
interface ValidateResult {
  success: boolean;
  error?: { issues?: IssueLike[]; errors?: IssueLike[] };
  notes?: IssueLike[];
}
type ValidateConfigFn = (config: unknown) => ValidateResult;
type LoadConfigFn = (opts: { filePath: string }) => Record<string, unknown> | undefined;

const key = (i: IssueLike): string => `${(i.path ?? []).join('.')} ${i.message}`;
const fmt = (i: IssueLike): string => `${(i.path ?? []).join('.')}: ${i.message}`;

// Mirror of validateDeployConfig: hard errors block; advisory notes = the SDK's
// with-notes issues minus the hard errors (dedup by path+message).
function classify(result: ValidateResult): { errors: string[]; notes: string[] } {
  const rawErrors: IssueLike[] = result.success ? [] : (result.error?.issues ?? result.error?.errors ?? []);
  const errorKeys = new Set(rawErrors.map(key));
  const rawNotes: IssueLike[] = (result.notes ?? []).filter((n) => !errorKeys.has(key(n)));
  return { errors: rawErrors.map(fmt), notes: rawNotes.map(fmt) };
}

suite('Pre-deploy config validation (real VS Code host + fs + SDK)', () => {
  let validateConfig: ValidateConfigFn;
  let loadAcurastConfig: LoadConfigFn;
  let tmpDir: string;
  let filePath: string;

  suiteSetup(async () => {
    assert.ok(vscode.version, 'must run inside the VS Code extension host');
    const [types, deploy] = await Promise.all([
      importESM('@acurast/sdk/types'),
      importESM('@acurast/sdk/deploy'),
    ]);
    validateConfig = types.validateConfig as unknown as ValidateConfigFn;
    loadAcurastConfig = deploy.loadAcurastConfig as unknown as LoadConfigFn;
  });

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-validate-test-'));
    filePath = path.join(tmpDir, 'acurast.json');
  });
  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Write a single-project acurast.json to disk, then run the SAME load+validate
  // pipeline deploy/estimate use: loadAcurastConfig(file) → validateConfig(config).
  function validateOnDisk(project: Record<string, unknown>): { errors: string[]; notes: string[] } {
    fs.writeFileSync(filePath, JSON.stringify({ projects: { demo: project } }, null, 2) + '\n');
    const config = loadAcurastConfig({ filePath });
    return classify(validateConfig(config));
  }

  // A schema-valid project with the default (NodeJS) runtime. Mirrors
  // fixtures/demo-workspace/acurast.json.
  const base: Record<string, unknown> = {
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

  test('a valid NodeJS config on disk validates clean — deploy proceeds', () => {
    const { errors, notes } = validateOnDisk(base);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(notes, []);
  });

  test('a valid Shell config (runtime + image) validates clean', () => {
    const { errors, notes } = validateOnDisk({
      ...base,
      runtime: 'Shell',
      image: { url: 'https://easycli.sh/rootfs.tar.xz', sha256: 'a'.repeat(64) },
    });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(notes, []);
  });

  test('a Shell config with no image is a non-blocking advisory note', () => {
    const { errors, notes } = validateOnDisk({ ...base, runtime: 'Shell' });
    assert.deepStrictEqual(errors, [], 'Shell-without-image must not block');
    assert.ok(notes.some((n) => /image is required/i.test(n)), `expected an image note, got: ${notes.join('; ')}`);
  });

  test('onlyAttestedDevices:false is a non-blocking advisory note', () => {
    const { errors, notes } = validateOnDisk({ ...base, onlyAttestedDevices: false });
    assert.deepStrictEqual(errors, []);
    assert.ok(notes.some((n) => n.startsWith('onlyAttestedDevices')), notes.join('; '));
  });

  test('instantMatch count != numberOfReplicas is a blocking error', () => {
    const { errors } = validateOnDisk({
      ...base,
      numberOfReplicas: 2,
      assignmentStrategy: { type: 'Single', instantMatch: [{ processor: '5abc', maxAllowedStartDelayInMs: 1000 }] },
    });
    assert.ok(
      errors.some((e) => /instantMatch entries must equal numberOfReplicas/.test(e)),
      `expected a blocking instantMatch error, got: ${errors.join('; ')}`,
    );
  });

  test('a missing required field is a blocking error', () => {
    const withoutCost = { ...base };
    delete withoutCost.maxCostPerExecution;
    const { errors } = validateOnDisk(withoutCost);
    assert.ok(errors.some((e) => e.startsWith('maxCostPerExecution')), errors.join('; '));
  });

  test('a hard error never leaks into the advisory notes (dedup)', () => {
    const { errors, notes } = validateOnDisk({
      ...base,
      numberOfReplicas: 2,
      onlyAttestedDevices: false,
      assignmentStrategy: { type: 'Single', instantMatch: [{ processor: '5abc', maxAllowedStartDelayInMs: 1000 }] },
    });
    assert.ok(errors.length > 0, 'expected a blocking error');
    for (const n of notes) assert.ok(!errors.includes(n), `note leaked as error: ${n}`);
    assert.ok(notes.some((n) => n.startsWith('onlyAttestedDevices')), `advisory still expected, got: ${notes.join('; ')}`);
  });
});
