// Pure, dependency-free network helpers shared by BOTH bundles: the extension
// host (status bar, studio panel) and the webview (mismatch banner). No vscode
// or fs imports here — config reads/writes live in `src/wallet/networkSetting.ts`.

/** Capitalize a network id for display, e.g. "mainnet" → "Mainnet". */
export function networkLabel(n: string): string {
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/**
 * True when a project's deploy network is known and differs from the Studio
 * target. A falsy/absent project network (no active acurast.json, or an
 * unreadable one) is treated as "no opinion" → never a mismatch — so all three
 * consumers agree on empty-string/undefined handling.
 */
export function isNetworkMismatch(
  projectNetwork: string | null | undefined,
  targetNetwork: string
): boolean {
  return !!projectNetwork && projectNetwork !== targetNetwork;
}
