import type { AcurastProjectConfig } from '@acurast/sdk/types';
import {
  ensureDeviceVersions,
  deviceVersionsAreStale,
  lookupBuildNumber,
  recentVersionNames,
  type ProcessorPlatform,
} from './deviceVersions';

/**
 * The chain stores a min processor version as a **build number**, but the number
 * a developer knows is the app version they see on the processor — `1.26.0`.
 * So `acurast.json` carries the readable name and Studio resolves it here,
 * against the live version table, before any SDK call that converts a config to
 * a job (`deployProject`, `getFeeAnalysis`, `fetchPricingAdvice`).
 *
 * Without this the SDK resolves names itself, but only against the table bundled
 * with the installed release — which stops at `1.13.0` — and throws
 * `Cannot resolve min processor version ... Please specify the build number
 * directly.` for everything newer.
 *
 * A raw build number (`128`, or `"128"` as older configs and `acurast init`
 * sometimes wrote it) is still accepted and passed straight through.
 */

/** Everything the pure resolver needs, injectable so tests need no network. */
export interface VersionResolver {
  /** Version name → build number, or `undefined` when the name is unknown. */
  lookup(platform: ProcessorPlatform, versionName: string): number | undefined;
  /** Known version names, newest first — quoted back in the error. */
  suggest(platform: ProcessorPlatform): string[];
  /** True when the live table could not be fetched, so a miss may be our fault. */
  stale: boolean;
}

const PLATFORM_LABEL: Record<ProcessorPlatform, string> = { android: 'Android', ios: 'iOS' };

export class UnknownProcessorVersionError extends Error {
  constructor(
    readonly platform: ProcessorPlatform,
    readonly version: string,
    resolver: VersionResolver
  ) {
    const known = resolver.suggest(platform);
    const lines = [
      `Unknown ${PLATFORM_LABEL[platform]} processor version "${version}" ` +
        `in acurast.json (minProcessorVersions.${platform}).`,
    ];
    if (known.length > 0) lines.push(`Known recent versions: ${known.join(', ')}.`);
    if (resolver.stale) {
      lines.push(
        'The live processor-version list could not be reached, so this list may be incomplete.'
      );
    }
    lines.push('You can also set the build number directly (a plain number).');
    super(lines.join('\n'));
    this.name = 'UnknownProcessorVersionError';
  }
}

const liveResolver: VersionResolver = {
  lookup: lookupBuildNumber,
  suggest: (platform) => recentVersionNames(platform),
  get stale() {
    return deviceVersionsAreStale();
  },
};

/**
 * Pure, synchronous resolution against an injected table. Returns the same
 * object reference when every value is already a build number.
 *
 * @throws UnknownProcessorVersionError when a version name has no build number.
 */
export function resolveMinProcessorVersionsWith<T extends AcurastProjectConfig>(
  config: T,
  resolver: VersionResolver
): T {
  const mv = config.minProcessorVersions;
  if (!mv) return config;

  const resolve = (
    platform: ProcessorPlatform,
    value: string | number | undefined
  ): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number') return value;

    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    // A bare number is already a build number — `acurast init` and older configs
    // wrote it quoted, and the SDK would treat that string as a version name.
    if (/^\d+$/.test(trimmed)) return Number(trimmed);

    const buildNumber = resolver.lookup(platform, trimmed);
    if (buildNumber === undefined) throw new UnknownProcessorVersionError(platform, trimmed, resolver);
    return buildNumber;
  };

  const android = resolve('android', mv.android);
  const ios = resolve('ios', mv.ios);
  if (android === mv.android && ios === mv.ios) return config;

  return { ...config, minProcessorVersions: { ...mv, android, ios } };
}

/**
 * Fetch the live version table (once per session) and resolve the config's
 * `minProcessorVersions` to build numbers.
 *
 * @throws UnknownProcessorVersionError when a version name has no build number.
 */
export async function resolveMinProcessorVersions<T extends AcurastProjectConfig>(
  config: T
): Promise<T> {
  await ensureDeviceVersions();
  return resolveMinProcessorVersionsWith(config, liveResolver);
}
