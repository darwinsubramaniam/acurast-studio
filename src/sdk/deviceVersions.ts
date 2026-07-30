import { deviceVersions, fetchDeviceVersions } from '@acurast/sdk/chain';

export type ProcessorPlatform = 'android' | 'ios';

/** Platform discriminants the SDK uses as keys in the `deviceVersions` map. */
const PLATFORM_ID: Record<ProcessorPlatform, number> = { android: 0, ios: 1 };

let inFlight: Promise<void> | undefined;
let fetchFailed = false;

/**
 * Merge the live processor-version table into the SDK's module-level
 * `deviceVersions` map, exactly once per session.
 *
 * The table bundled with the SDK stops at build 73 (`1.13.0`), so without this
 * every human-readable version a developer would actually write in
 * `acurast.json` — `"1.26.0"` and anything else recent — is unresolvable.
 * Concurrent callers share one in-flight fetch.
 *
 * Best-effort by design: a failed fetch resolves quietly and leaves the bundled
 * table in place, but flips {@link deviceVersionsAreStale} so callers can say so
 * when a name then fails to resolve.
 */
export function ensureDeviceVersions(): Promise<void> {
  return (inFlight ??= fetchDeviceVersions()
    .then(() => { fetchFailed = false; })
    .catch(() => { fetchFailed = true; }));
}

/** True when the live table could not be fetched, so the map may be out of date. */
export function deviceVersionsAreStale(): boolean {
  return fetchFailed;
}

/** Test seam — drops the memoised fetch so the next `ensureDeviceVersions` re-runs. */
export function resetDeviceVersions(): void {
  inFlight = undefined;
  fetchFailed = false;
}

/**
 * Build number for a human-readable version name (`"1.26.0"` → `128`).
 *
 * A name can map to several builds (123 and 124 are both `1.25.1`). For a
 * *minimum* version the lowest one is correct: a processor on build 123 is
 * running 1.25.1 and must satisfy a `>= 1.25.1` requirement.
 */
export function lookupBuildNumber(platform: ProcessorPlatform, versionName: string): number | undefined {
  const table = deviceVersions.get(PLATFORM_ID[platform]);
  if (!table) return undefined;

  let lowest: number | undefined;
  for (const [buildNumber, name] of table) {
    if (name === versionName && (lowest === undefined || buildNumber < lowest)) lowest = buildNumber;
  }
  return lowest;
}

/** Known version names for a platform, newest build first — makes errors actionable. */
export function recentVersionNames(platform: ProcessorPlatform, limit = 6): string[] {
  const table = deviceVersions.get(PLATFORM_ID[platform]);
  if (!table) return [];

  const names: string[] = [];
  for (const [, name] of [...table].sort((a, b) => b[0] - a[0])) {
    if (!names.includes(name)) names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}
