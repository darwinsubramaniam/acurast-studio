// Build tools (cargo, npm, …) emit ANSI escape sequences for color/cursor moves.
// A plain VS Code OutputChannel can't render them, and they'd show as garbage in
// the webview log view — so strip them and color by log level instead.
// Handles CSI sequences (ESC[ … m colors, cursor controls) — the common case for
// build output.
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PRZcf-nqry=><]/g;

/** Remove ANSI escape sequences (colors, cursor controls) from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}
