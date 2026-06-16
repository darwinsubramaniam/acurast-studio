// Pure helpers for the acurast.json project config, extracted from
// Settings.svelte so the patch-building and validation can be unit-tested
// without booting a Svelte component. Plain data in, plain data out — no
// Svelte/DOM imports.
//
// `draft` is the form's per-field edit map (keys may be dotted, e.g.
// `image.url`); `project` is the currently-selected project object from
// acurast.json (null when none is selected).

import type { InstantMatchEntry } from '../../types';

const DEFAULT_START_DELAY_MS = 10_000;
const RUNTIME_DEFAULT = 'NodeJSWithBundle';
const EXEC_TYPE_DEFAULT = 'onetime';
const SHA256_RE = /^[a-fA-F0-9]{64}$/;

// ── Predicates & shared helpers ───────────────────────────────────────────────

/** Read a draft field, falling back to the stored value when unedited. */
function readDraft(draft: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return key in draft ? draft[key] : fallback;
}

/** A non-null, non-array object — i.e. one that's safe to deep-merge into. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Walk a nested object by a path of keys; undefined if any hop is missing. */
export function getNested(p: Record<string, unknown>, ...keys: string[]): unknown {
  let cur: unknown = p;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// Read an instantMatch field from a stored config, tolerating both the SDK's
// array shape `[{ processor, maxAllowedStartDelayInMs }]` and the legacy
// single-object shape `{ processor, ... }`.
export function instantMatchField(p: Record<string, unknown>, field: string): unknown {
  const im = getNested(p, 'assignmentStrategy', 'instantMatch');
  const first = Array.isArray(im) ? im[0] : im;
  return first && typeof first === 'object' ? (first as Record<string, unknown>)[field] : undefined;
}

/** Coerce a raw value to a non-negative finite delay, defaulting to 10s. */
function toDelay(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_START_DELAY_MS;
}

// Read a stored config's instantMatch as a clean entry list, tolerating both the
// SDK's array shape `[{ processor, maxAllowedStartDelayInMs }]` and the legacy
// single-object shape. Entries with a blank processor are dropped.
export function instantMatchEntries(p: Record<string, unknown> | null): InstantMatchEntry[] {
  const im = p ? getNested(p, 'assignmentStrategy', 'instantMatch') : undefined;
  const raw = Array.isArray(im) ? im : im != null ? [im] : [];
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
    .filter((e) => e.processor != null && String(e.processor).trim() !== '')
    .map((e) => ({
      processor: String(e.processor).trim(),
      maxAllowedStartDelayInMs: toDelay(e.maxAllowedStartDelayInMs),
    }));
}

/** Recursively merge `source` onto `target`; nested plain objects merge, everything else overwrites. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [k, v] of Object.entries(source)) {
    const existing = result[k];
    result[k] = isPlainObject(v) && isPlainObject(existing) ? deepMerge(existing, v) : v;
  }
  return result;
}

/**
 * Assign `value` at a dotted path inside `obj`, creating intermediate objects.
 * Guard intentionally mirrors the original inline logic (NOT `isPlainObject`):
 * a pre-existing `null` intermediate is left as-is rather than replaced.
 */
function setNested(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in node) || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

// ── Patch building ────────────────────────────────────────────────────────────

/** Split a delimited string into a trimmed, empties-removed list. */
function splitList(value: string, sep: string): string[] {
  return value.split(sep).map((s) => s.trim()).filter(Boolean);
}

/** Parse the reuseKeysFrom field: ''/'null' → null, valid JSON → parsed, invalid → left unset. */
function applyReuseKeysFrom(patch: Record<string, unknown>, value: unknown): void {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'null') {
    patch.reuseKeysFrom = null;
  } else {
    try {
      patch.reuseKeysFrom = JSON.parse(raw);
    } catch {
      /* skip invalid */
    }
  }
}

/** Map each draft field into the patch: list splits, reuseKeysFrom, dotted expansion, plain copy. */
function applyFieldEdits(draft: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft)) {
    if (k === 'includeEnvironmentVariables' && typeof v === 'string') {
      patch[k] = splitList(v, ',');
    } else if (k === 'processorWhitelist' && typeof v === 'string') {
      patch[k] = splitList(v, '\n');
    } else if (k === 'reuseKeysFrom') {
      applyReuseKeysFrom(patch, v);
    } else if (k.includes('.')) {
      setNested(patch, k.split('.'), v);
    } else {
      patch[k] = v;
    }
  }
  return patch;
}

/** Deep-merge each nested-object patch field back onto the original project value. */
function mergeOntoOriginal(patch: Record<string, unknown>, project: Record<string, unknown>): void {
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const orig = project[k];
    if (isPlainObject(pv) && isPlainObject(orig)) {
      patch[k] = deepMerge(orig, pv);
    }
  }
}

/**
 * Resolve the schema-required maxAllowedStartDelayInMs: the draft value, then
 * the stored instantMatch value, then the top-level draft/stored value, then 10s.
 */
function resolveStartDelay(
  entry: Record<string, unknown>,
  draft: Record<string, unknown>,
  currentProject: Record<string, unknown>,
): number {
  const candidates = [
    entry.maxAllowedStartDelayInMs,
    instantMatchField(currentProject, 'maxAllowedStartDelayInMs'),
    readDraft(draft, 'maxAllowedStartDelayInMs', currentProject.maxAllowedStartDelayInMs),
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (c != null && Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_START_DELAY_MS;
}

/**
 * Normalize assignmentStrategy. The SDK validates instantMatch as an ARRAY of
 * { processor, maxAllowedStartDelayInMs } (it calls .map on it). instantMatch may
 * hold zero, one, or many processors — each with its own start delay — so clean
 * every entry: trim its processor, resolve its delay, and drop blanks. An empty
 * result (or a Competing strategy) drops instantMatch entirely (open matching).
 * Tolerates a legacy single-object draft by treating it as a one-element array.
 */
function normalizeInstantMatch(
  patch: Record<string, unknown>,
  draft: Record<string, unknown>,
  project: Record<string, unknown> | null,
): void {
  if (!(patch.assignmentStrategy && typeof patch.assignmentStrategy === 'object')) return;
  const strategy = patch.assignmentStrategy as Record<string, unknown>;
  if (strategy.type === 'Competing') {
    delete strategy.instantMatch;
    return;
  }
  if (strategy.instantMatch == null) return;

  const currentProject = project ?? {};
  const raw = Array.isArray(strategy.instantMatch) ? strategy.instantMatch : [strategy.instantMatch];
  const entries = raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
    .filter((e) => e.processor != null && String(e.processor).trim() !== '')
    .map((e) => ({
      processor: String(e.processor).trim(),
      maxAllowedStartDelayInMs: resolveStartDelay(e, draft, currentProject),
    }));
  if (entries.length === 0) {
    delete strategy.instantMatch;
    return;
  }
  strategy.instantMatch = entries;
}

/** Null out minProcessorVersions when every version field is blank. Guard is array-inclusive. */
function pruneEmptyMinProcessorVersions(patch: Record<string, unknown>): void {
  if (!(patch.minProcessorVersions && typeof patch.minProcessorVersions === 'object')) return;
  const mv = patch.minProcessorVersions as Record<string, unknown>;
  const hasAny = Object.values(mv).some((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (!hasAny) patch.minProcessorVersions = null;
}



// ── Validation ────────────────────────────────────────────────────────────────

interface ValidationCtx {
  /** Read a draft field with the stored value as fallback. */
  read: (key: string, fallback: unknown) => unknown;
  project: Record<string, unknown>;
  draft: Record<string, unknown>;
}
type ValidationRule = (ctx: ValidationCtx) => Record<string, string>;

const requireProjectName: ValidationRule = ({ read, project }) => {
  const errs: Record<string, string> = {};
  const name = read('projectName', project.projectName);
  if (!name || String(name).trim() === '') errs.projectName = 'Required';
  return errs;
};

const requireFileUrl: ValidationRule = ({ read, project }) => {
  const errs: Record<string, string> = {};
  const fUrl = read('fileUrl', project.fileUrl);
  if (!fUrl || String(fUrl).trim() === '') errs.fileUrl = 'Required';
  return errs;
};

const validateShellImage: ValidationRule = ({ read, project }) => {
  const runtime = (read('runtime', project.runtime) ?? RUNTIME_DEFAULT) as string;
  if (runtime !== 'Shell') return {};
  const errs: Record<string, string> = {};
  const imgUrl = read('image.url', getNested(project, 'image', 'url'));
  if (!imgUrl || String(imgUrl).trim() === '') errs['image.url'] = 'Required for Shell runtime';
  const imgSha = read('image.sha256', getNested(project, 'image', 'sha256'));
  if (!imgSha || String(imgSha).trim() === '') {
    errs['image.sha256'] = 'Required for Shell runtime';
  } else if (!SHA256_RE.test(String(imgSha))) {
    errs['image.sha256'] = 'Must be 64-character hex string';
  }
  return errs;
};

const validateExecution: ValidationRule = ({ read, project }) => {
  const execType = (read('execution.type', getNested(project, 'execution', 'type')) ?? EXEC_TYPE_DEFAULT) as string;
  if (execType !== 'interval') return {};
  const errs: Record<string, string> = {};
  const iv = read('execution.intervalInMs', getNested(project, 'execution', 'intervalInMs'));
  if (!iv || Number(iv) <= 0) errs['execution.intervalInMs'] = 'Required, must be > 0';
  const ne = read('execution.numberOfExecutions', getNested(project, 'execution', 'numberOfExecutions'));
  if (!ne || Number(ne) <= 0 || !Number.isInteger(Number(ne))) errs['execution.numberOfExecutions'] = 'Required, positive integer';
  return errs;
};

const validateReuseKeys: ValidationRule = ({ draft }) => {
  const errs: Record<string, string> = {};
  const reuseVal = draft.reuseKeysFrom;
  if (reuseVal === undefined || reuseVal === null) return errs;
  const raw = String(reuseVal).trim();
  if (!raw || raw === 'null') return errs;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3 ||
      parsed[0] !== 'Acurast' || typeof parsed[1] !== 'string' || typeof parsed[2] !== 'number') {
      errs.reuseKeysFrom = 'Must be ["Acurast", "address", deploymentId]';
    }
  } catch {
    errs.reuseKeysFrom = 'Invalid JSON';
  }
  return errs;
};

const RULES: ValidationRule[] = [
  requireProjectName,
  requireFileUrl,
  validateShellImage,
  validateExecution,
  validateReuseKeys,
];

/**
 * Validate the draft against the selected project. Returns a field→message map
 * ({} when valid); the same dotted keys used by the form (`image.sha256`, etc.).
 */
export function validateConfig(
  draft: Record<string, unknown>,
  project: Record<string, unknown> | null,
): Record<string, string> {
  if (!project) return {};
  const ctx: ValidationCtx = {
    read: (key, fallback) => readDraft(draft, key, fallback),
    project,
    draft,
  };
  const errs: Record<string, string> = {};
  for (const rule of RULES) Object.assign(errs, rule(ctx));
  return errs;
}

/**
 * Turn the form's per-field draft into the patch object sent to the host for
 * `config.save`: field edits → deep-merge onto the original → instantMatch
 * normalization → minProcessorVersions cleanup.
 */
export function buildPatch(
  draft: Record<string, unknown>,
  project: Record<string, unknown> | null,
): Record<string, unknown> {
  const patch = applyFieldEdits(draft);
  mergeOntoOriginal(patch, project ?? {});
  normalizeInstantMatch(patch, draft, project);
  pruneEmptyMinProcessorVersions(patch);
  return patch;
}
