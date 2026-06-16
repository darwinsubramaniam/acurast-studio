<script lang="ts">
  // A monospace value with a copy button — the single DNS record value pattern.
  // `host` adds a second muted line (used for the per-relay IP + hostname rows);
  // `wrap` lets a long value (the base64 TXT) wrap instead of scroll.
  import { send } from "../lib/vscode";
  import { ICONS } from "../lib/icons";

  interface Props {
    value: string;
    host?: string;
    wrap?: boolean;
  }
  let { value, host, wrap = false }: Props = $props();
</script>

<div class="copy-row">
  {#if host}
    <div class="cr-ip">
      <code>{value}</code>
      <span class="cr-host">{host}</span>
    </div>
  {:else}
    <code class:wrap>{value}</code>
  {/if}
  <button class="copy-btn" title="Copy" onclick={() => send("deploy.copy", { text: value })}>
    {@html ICONS.copy}
  </button>
</div>

<style>
  .copy-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0;
  }
  .copy-row > code,
  .cr-ip {
    flex: 1;
    min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    border-radius: 6px;
    color: var(--vscode-foreground);
  }
  .copy-row > code {
    overflow-x: auto;
    white-space: nowrap;
  }
  .copy-row > code.wrap {
    word-break: break-all;
    white-space: normal;
  }
  .cr-ip {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .cr-ip code {
    background: transparent;
    padding: 0;
    font-size: 11px;
  }
  .cr-host {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
  }
  .copy-btn {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 6px;
  }
  .copy-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .copy-btn :global(svg) {
    width: 13px;
    height: 13px;
  }
</style>
