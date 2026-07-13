// Pure scaffolding for the "Acurast: Init Project" wizard (commands/newProject.ts).
// Builds the acurast.json project entry plus the starter files for each runtime,
// so the interactive command stays a thin VS Code shell and the generated output
// is unit-testable. The field set and defaults mirror what `acurast init`
// (CLI v0.9.x) writes, extended with the runtime-specific fields the CLI does
// not offer: `runtime`, `entrypoint`, and — for Shell — `image` { url, sha256 }.
// No vscode imports here — plain data in, plain data out.

/** Runtimes offered by the wizard. NodeJSWithBundle stays reachable via Project Settings. */
export type InitRuntime = 'NodeJS' | 'Shell';

export interface ImageRef {
  url: string;
  sha256: string;
}

export type InitExecution =
  | { type: 'onetime'; maxExecutionTimeInMs: number }
  | { type: 'interval'; intervalInMs: number; numberOfExecutions: number };

export interface InitOptions {
  name: string;
  runtime: InitRuntime;
  network: string;
  execution: InitExecution;
  /**
   * Shell only. Omitted (or empty url/sha256) means "fill in later" — the
   * Project Settings panel flags the empty fields and the SDK refuses to
   * deploy a Shell project without an image, so nothing ships half-configured.
   */
  image?: ImageRef;
}

// CLI-parity defaults (SDK `DEFAULT_REWARD` / `DEFAULT_MAX_ALLOWED_START_DELAY_MS`).
const DEFAULT_REWARD = 100_000_000_000;
const DEFAULT_START_DELAY_MS = 10_000;
// Shell runtime + image support need a recent processor build (see the
// deployment-config docs); applied to both runtimes for consistency.
const MIN_ANDROID_PROCESSOR_VERSION = '1.26.0';

// ── Duration input ────────────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000, sec: 1_000, secs: 1_000,
  m: 60_000, min: 60_000, mins: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

/**
 * "30s" / "10min" / "2h" / "1h 30m" → milliseconds; undefined when invalid.
 * A unit is required — a bare number is ambiguous, so it's rejected rather
 * than guessed at.
 */
export function parseDurationMs(input: string): number | undefined {
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*/y;
  let total = 0;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return undefined;
    const unit = UNIT_MS[m[2]];
    if (unit === undefined) return undefined;
    total += Number(m[1]) * unit;
    pos = re.lastIndex;
  }
  return total > 0 ? Math.round(total) : undefined;
}

// ── acurast.json ──────────────────────────────────────────────────────────────

/** The `projects.<name>` entry. Key order follows the docs' field reference. */
export function buildProjectEntry(opts: InitOptions): Record<string, unknown> {
  const shell = opts.runtime === 'Shell';
  return {
    projectName: opts.name,
    fileUrl: shell ? 'app' : 'index.js',
    entrypoint: shell ? 'start.sh' : 'index.js',
    runtime: opts.runtime,
    // Always present for Shell so a skipped pick leaves visible blanks to fill.
    ...(shell ? { image: opts.image ?? { url: '', sha256: '' } } : {}),
    network: opts.network,
    onlyAttestedDevices: true,
    assignmentStrategy: { type: 'Single' },
    execution: opts.execution,
    maxAllowedStartDelayInMs: DEFAULT_START_DELAY_MS,
    usageLimit: { maxMemory: 0, maxNetworkRequests: 0, maxStorage: 0 },
    numberOfReplicas: 1,
    // The chain rejects Shell jobs on processors without the Shell module, and
    // the SDK auto-injects it anyway — write it explicitly so the config is
    // honest about what it requires.
    requiredModules: shell ? ['Shell'] : [],
    minProcessorReputation: 0,
    maxCostPerExecution: DEFAULT_REWARD,
    includeEnvironmentVariables: [],
    processorWhitelist: [],
    minProcessorVersions: { android: MIN_ANDROID_PROCESSOR_VERSION },
  };
}

// ── Starter files ─────────────────────────────────────────────────────────────

export interface Scaffold {
  /** Relative path → file contents. Paths use '/' separators. */
  files: Record<string, string>;
  /** Relative paths that should be chmod +x after writing. */
  executable: string[];
}

const DOCS_URL = 'https://docs.acurast.com/developers/build/deployment-config';

function nodeIndexJs(name: string): string {
  return [
    `// ${name} — entry point, executed on Acurast processors (NodeJS runtime).`,
    `// Docs: ${DOCS_URL}`,
    '',
    `console.log('Hello from ${name} on Acurast!');`,
    '',
  ].join('\n');
}

function shellStartSh(name: string): string {
  return [
    '#!/bin/sh',
    `# ${name} — entrypoint, executed inside the rootfs image on an Acurast`,
    '# processor (Shell runtime). Everything in this folder ships with the',
    '# deployment; the image is set in acurast.json (image.url / image.sha256).',
    `# Docs: ${DOCS_URL}`,
    '',
    `echo "Hello from ${name} on Acurast!"`,
    '',
  ].join('\n');
}

function readme(opts: InitOptions, imagePending: boolean): string {
  const shell = opts.runtime === 'Shell';
  const lines = [
    `# ${opts.name}`,
    '',
    `Acurast deployment project (${shell ? 'Shell' : 'Node.js'} runtime), created by Acurast Studio.`,
    '',
    '- `acurast.json` — deployment config; edit it in Acurast Studio → Project Settings',
    shell
      ? '- `app/start.sh` — the entrypoint processors run inside the rootfs image'
      : '- `index.js` — the script processors run',
    '',
  ];
  if (imagePending) {
    lines.push(
      '> **Before deploying:** pick a rootfs image in Acurast Studio → Project',
      '> Settings → Image (or paste your own `.tar.xz` URL and its SHA256).',
      ''
    );
  }
  lines.push(
    'Deploy from the Acurast Studio panel: pick a funded wallet, review the',
    'config in Project Settings, then use the Deploy view.',
    ''
  );
  return lines.join('\n');
}

/** Everything the wizard writes into the new project folder. */
export function buildScaffold(opts: InitOptions): Scaffold {
  const shell = opts.runtime === 'Shell';
  const imagePending = shell && !(opts.image?.url && opts.image?.sha256);
  const files: Record<string, string> = {
    'acurast.json':
      JSON.stringify({ projects: { [opts.name]: buildProjectEntry(opts) } }, null, 2) + '\n',
    // CLI parity: `acurast init` gitignores the .acurast scratch dir and .env.
    '.gitignore': (shell ? ['.acurast', '.env'] : ['node_modules/', '.acurast', '.env']).join('\n') + '\n',
    'README.md': readme(opts, imagePending),
  };
  if (shell) {
    files['app/start.sh'] = shellStartSh(opts.name);
  } else {
    files['index.js'] = nodeIndexJs(opts.name);
    files['package.json'] =
      JSON.stringify({ name: opts.name, version: '0.1.0', private: true, main: 'index.js' }, null, 2) + '\n';
  }
  return { files, executable: shell ? ['app/start.sh'] : [] };
}
