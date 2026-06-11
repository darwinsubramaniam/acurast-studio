import * as fs from 'fs';
import * as vscode from 'vscode';
import { LokiClient } from './lokiClient';
import { resolveLokiConfig } from './lokiConfig';
import type { LokiQueryParams, LVInMsg, LogRow } from './types';

const TAIL_INTERVAL_MS = 3_000;
/** Overlap window (ms) re-queried on each tail poll to avoid missing lines that
 * land out of order at the boundary; duplicates are filtered by tsNs. */
const TAIL_OVERLAP_MS = 2_000;

interface ViewerEntry {
  panel: vscode.WebviewPanel;
  params: LokiQueryParams;
  /** Highest nanosecond timestamp shown, for tail de-duplication. */
  lastTsNs: string;
  tailTimer?: NodeJS.Timeout;
  /** Bumped on every new query/tail start so a slow in-flight fetch is dropped. */
  gen: number;
}

/**
 * Owns the Live Monitoring log-viewer editor tabs. Each distinct job opens (or
 * reveals) its own webview panel; queries and live tail run on the host so the
 * webview never makes cross-origin requests.
 */
export class LogViewerManager {
  private static readonly viewType = 'acurastLogViewer';
  private readonly entries = new Map<string, ViewerEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage
  ) {}

  /** Open or focus a log viewer for the given query and run it. */
  async open(params: LokiQueryParams): Promise<void> {
    const key = this.keyOf(params);
    const existing = this.entries.get(key);
    if (existing) {
      existing.params = params;
      existing.lastTsNs = '';
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active);
      await this.postInit(existing);
      await this.runQuery(existing);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      LogViewerManager.viewType,
      this.titleFor(params),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'acurast-icon.svg');
    panel.webview.html = this.html(panel.webview);

    const entry: ViewerEntry = { panel, params, lastTsNs: '', gen: 0 };
    this.entries.set(key, entry);

    panel.webview.onDidReceiveMessage((msg: LVInMsg) => void this.handle(entry, msg));
    panel.onDidDispose(() => {
      this.stopTail(entry);
      this.entries.delete(key);
    });
    // The webview posts `lv.ready` once mounted; init + first query happen then.
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.stopTail(entry);
      entry.panel.dispose();
    }
    this.entries.clear();
  }

  private keyOf(p: LokiQueryParams): string {
    return p.origin && p.localId !== undefined
      ? `${p.network}:${p.origin}:${p.localId}`
      : `${p.network}:${p.query}`;
  }

  private titleFor(p: LokiQueryParams): string {
    return `Logs · ${p.title}`;
  }

  private async handle(entry: ViewerEntry, msg: LVInMsg): Promise<void> {
    switch (msg.type) {
      case 'lv.ready':
        await this.postInit(entry);
        await this.runQuery(entry);
        break;
      case 'lv.query':
        this.stopTail(entry);
        entry.params = msg.params;
        entry.lastTsNs = '';
        await this.runQuery(entry);
        break;
      case 'lv.tail':
        entry.params = msg.params;
        if (msg.active) this.startTail(entry);
        else this.stopTail(entry);
        break;
      case 'lv.copy':
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('Copied log line', 1500);
        }
        break;
      case 'lv.configure':
        await vscode.commands.executeCommand('acurast.loki.configure');
        break;
    }
  }

  private async postInit(entry: ViewerEntry): Promise<void> {
    const cfg = await resolveLokiConfig(entry.params.network, this.secrets);
    entry.panel.title = this.titleFor(entry.params);
    this.post(entry, {
      type: 'lv.init',
      params: entry.params,
      endpointConfigured: cfg.configured,
      endpointUrl: cfg.baseUrl,
    });
  }

  private async runQuery(entry: ViewerEntry): Promise<void> {
    const gen = ++entry.gen;
    this.post(entry, { type: 'lv.loading' });
    const started = Date.now();
    try {
      const cfg = await resolveLokiConfig(entry.params.network, this.secrets);
      const client = new LokiClient(cfg);
      const { rows, capped } = await client.queryRange({
        query: entry.params.query,
        startMs: entry.params.startMs,
        endMs: entry.params.endMs,
        limit: entry.params.limit,
        direction: entry.params.direction,
      });
      if (gen !== entry.gen) return; // superseded
      entry.lastTsNs = maxTsNs(rows, entry.lastTsNs);
      this.post(entry, {
        type: 'lv.result',
        rows,
        params: entry.params,
        stats: { returned: rows.length, elapsedMs: Date.now() - started, capped },
      });
    } catch (err) {
      if (gen !== entry.gen) return;
      this.post(entry, { type: 'lv.error', message: (err as Error).message });
    }
  }

  private startTail(entry: ViewerEntry): void {
    this.stopTail(entry);
    this.post(entry, { type: 'lv.tailState', active: true });
    const tick = async () => {
      const gen = entry.gen;
      try {
        const cfg = await resolveLokiConfig(entry.params.network, this.secrets);
        const client = new LokiClient(cfg);
        const now = Date.now();
        const startMs = entry.lastTsNs
          ? Math.floor(Number(entry.lastTsNs.slice(0, -6))) - TAIL_OVERLAP_MS
          : entry.params.endMs;
        const { rows } = await client.queryRange({
          query: entry.params.query,
          startMs,
          endMs: now,
          limit: entry.params.limit,
          direction: 'forward',
        });
        if (gen !== entry.gen || !entry.tailTimer) return;
        const fresh = entry.lastTsNs
          ? rows.filter((r) => cmpNs(r.tsNs, entry.lastTsNs) > 0)
          : rows;
        if (fresh.length) {
          entry.lastTsNs = maxTsNs(fresh, entry.lastTsNs);
          this.post(entry, {
            type: 'lv.result',
            rows: fresh,
            append: true,
            params: entry.params,
            stats: { returned: fresh.length, elapsedMs: 0, capped: false },
          });
        }
      } catch (err) {
        // Surface tail failures but keep the timer running so it self-heals.
        this.post(entry, { type: 'lv.error', message: `Tail: ${(err as Error).message}` });
      }
    };
    entry.tailTimer = setInterval(() => void tick(), TAIL_INTERVAL_MS);
    void tick();
  }

  private stopTail(entry: ViewerEntry): void {
    if (entry.tailTimer) {
      clearInterval(entry.tailTimer);
      entry.tailTimer = undefined;
      this.post(entry, { type: 'lv.tailState', active: false });
    }
  }

  private post(entry: ViewerEntry, msg: unknown): void {
    void entry.panel.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'studio', 'global.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'studio', 'logviewer.js')
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    const raw = fs.readFileSync(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'studio', 'logviewer.html').fsPath,
      'utf8'
    );
    return raw
      .replace('{{CSP}}', csp)
      .replace('{{STYLE_URI}}', styleUri.toString())
      .replace('{{SCRIPT_URI}}', scriptUri.toString())
      .replace('{{NONCE}}', nonce);
  }
}

function maxTsNs(rows: LogRow[], current: string): string {
  let max = current;
  for (const r of rows) if (cmpNs(r.tsNs, max) > 0) max = r.tsNs;
  return max;
}

function cmpNs(a: string, b: string): number {
  if (!b) return 1;
  if (!a) return -1;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
