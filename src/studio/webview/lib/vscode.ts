declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export const vscode = acquireVsCodeApi();

export function send(type: string, extra: Record<string, unknown> = {}): void {
  vscode.postMessage({ type, ...extra });
}
