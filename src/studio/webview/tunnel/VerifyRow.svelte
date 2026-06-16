<script lang="ts">
  // A single verify result line. `big` renders the bordered card form with a
  // verified/pending badge and an optional mono detail (the partial-verify rows);
  // otherwise a compact inline tick line (the live summary rows). A pending big
  // row shows the shared spinner in place of the tick.
  import { ICONS } from "../lib/icons";
  import Spinner from "../shared/Spinner.svelte";

  interface Props {
    ok: boolean;
    title: string;
    detail?: string;
    big?: boolean;
  }
  let { ok, title, detail, big = false }: Props = $props();
</script>

{#if big}
  <div class="verify-row big">
    <span class="vr-mark" class:ok class:pending={!ok}>
      {#if ok}{@html ICONS.check}{:else}<Spinner size={16} />{/if}
    </span>
    <div class="vr-body">
      <div class="vr-title">
        {title}
        <span class="vr-badge" class:ok class:pending={!ok}>{ok ? "verified" : "pending"}</span>
      </div>
      {#if detail}<code class="vr-detail">{detail}</code>{/if}
    </div>
  </div>
{:else}
  <div class="verify-row">
    <span class="vr-mark ok">{@html ICONS.check}</span>
    <span>{title}</span>
  </div>
{/if}

<style>
  .verify-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
    font-size: 12px;
  }
  .verify-row.big {
    align-items: flex-start;
    padding: 10px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 10px;
  }
  .vr-mark {
    flex-shrink: 0;
    display: inline-flex;
  }
  .vr-mark :global(svg) {
    width: 16px;
    height: 16px;
  }
  .vr-mark.ok {
    color: var(--acu-accent-soft-fg);
  }
  .vr-mark.pending {
    color: var(--vscode-charts-yellow, #cca700);
  }
  .vr-body {
    flex: 1;
    min-width: 0;
  }
  .vr-title {
    font-size: 12.5px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .vr-badge {
    font-size: 8.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 999px;
  }
  .vr-badge.ok {
    background: var(--acu-accent-soft-bg);
    color: var(--acu-accent-soft-fg);
  }
  .vr-badge.pending {
    background: var(--vscode-input-background);
    color: var(--vscode-charts-yellow, #cca700);
  }
  .vr-detail {
    display: block;
    margin-top: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground);
    word-break: break-all;
  }
</style>
