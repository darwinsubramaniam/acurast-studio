import type { AcurastProjectConfig } from '@acurast/sdk/types';

/**
 * The SDK's `convertConfigToJob` treats a STRING `minProcessorVersions` entry
 * as a version *name* to resolve (e.g. "1.26.0") and throws if it isn't a known
 * name, whereas a NUMBER is used directly as the build number. The Acurast docs
 * and `acurast init` sometimes write the build number as a quoted string
 * (e.g. `"122"`), which the installed SDK cannot resolve — it throws
 * `Cannot resolve min processor version ... Please specify the build number directly.`
 *
 * Coerce purely-numeric strings to numbers so both `122` and `"122"` work.
 * Non-numeric strings (real version names) are left untouched for the SDK to
 * resolve. Returns the same object reference when nothing changed.
 */
export function normalizeMinProcessorVersions<T extends AcurastProjectConfig>(config: T): T {
  const mv = config.minProcessorVersions;
  if (!mv) return config;

  const coerce = (v: string | number | undefined): string | number | undefined =>
    typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;

  const android = coerce(mv.android);
  const ios = coerce(mv.ios);
  if (android === mv.android && ios === mv.ios) return config;

  return { ...config, minProcessorVersions: { ...mv, android, ios } };
}
