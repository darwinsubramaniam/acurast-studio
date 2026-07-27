/**
 * Return the URL string iff `raw` parses as an `https://` URL, else undefined.
 *
 * The webview is CSP-locked and trusted, but every host handler that hands a
 * webview-supplied URL to `vscode.env.openExternal` must still confine it to
 * https — an unchecked value could otherwise open a `file:`, `command:`, or
 * `vscode:` URI (the latter can invoke commands). Defense-in-depth against a
 * future webview compromise.
 */
export function httpsExternalUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
