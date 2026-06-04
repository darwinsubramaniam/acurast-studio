<script lang="ts">
  import type { DiagnosisStateMsg, DiagnosisStatus } from "../types";
  import { truncate } from "./lib/format";

  interface Props {
    state: DiagnosisStateMsg | undefined;
  }
  let { state }: Props = $props();

  const ICON: Record<DiagnosisStatus, string> = {
    pass: "✓",
    fail: "✗",
    warn: "⚠",
    info: "○",
  };
</script>

{#if state}
  <div class="diag">
    {#if state.status === "loading"}
      <div class="diag-line muted">Diagnosing on-chain…</div>
    {:else if state.status === "error"}
      <div class="diag-line fail">Diagnosis failed: {state.error}</div>
    {:else if state.status === "ok" && state.result}
      {@const r = state.result}
      <div class="diag-summary status-{r.jobStatus}" class:expired={r.expired}>
        <strong>{r.summary}</strong>
        {#if r.found}<span class="diag-status"
            >status: {r.expired ? "expired" : r.jobStatus}</span
          >{/if}
      </div>

      {#if r.checks.length}
        <ul class="diag-checks">
          {#each r.checks as c (c.id)}
            <li class="chk {c.status}">
              <span class="chk-ico">{ICON[c.status]}</span>
              <span class="chk-label">{c.label}</span>
              <span class="chk-detail">{c.detail}</span>
            </li>
          {/each}
        </ul>
      {/if}

      {#each r.processors as p (p.address)}
        <div class="diag-proc">
          <div class="diag-proc-head">
            <span class="chk-ico {p.eligible ? 'pass' : 'fail'}"
              >{p.eligible ? ICON.pass : ICON.fail}</span
            >
            Processor {truncate(p.address, 8)}
            <span class="muted">{p.eligible ? "eligible" : "not eligible"}</span>
          </div>
          <ul class="diag-checks">
            {#each p.checks as c (c.id)}
              <li class="chk {c.status}">
                <span class="chk-ico">{ICON[c.status]}</span>
                <span class="chk-label">{c.label}</span>
                <span class="chk-detail">{c.detail}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .diag {
    margin-top: 6px;
    padding: 6px 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-editorWidget-background);
    font-size: 11px;
  }
  .diag-line {
    padding: 2px 0;
  }
  .diag-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 4px;
  }
  .diag-status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  .diag-checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .chk {
    display: grid;
    grid-template-columns: 14px auto 1fr;
    gap: 6px;
    align-items: baseline;
  }
  .chk-ico {
    text-align: center;
    font-weight: 700;
  }
  .chk-label {
    font-weight: 600;
    white-space: nowrap;
  }
  .chk-detail {
    color: var(--vscode-descriptionForeground);
    word-break: break-word;
  }
  .diag-proc {
    margin-top: 6px;
    padding-top: 4px;
    border-top: 1px dashed var(--vscode-panel-border);
  }
  .diag-proc-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-weight: 600;
    margin-bottom: 3px;
  }
  .diag-proc-head .muted {
    font-weight: 400;
    font-size: 10px;
  }
  .muted {
    color: var(--vscode-descriptionForeground);
  }
  /* status colors */
  .pass,
  .chk.pass .chk-ico {
    color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #3fb950));
  }
  .fail,
  .chk.fail .chk-ico {
    color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, #f85149));
  }
  .warn,
  .chk.warn .chk-ico {
    color: var(--vscode-editorWarning-foreground, #d29922);
  }
  .chk.info .chk-ico {
    color: var(--vscode-descriptionForeground);
  }
  .status-assigned strong {
    color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #3fb950));
  }
  /* Expiry overrides the green "assigned" tint — an ended job isn't healthy. */
  .diag-summary.expired strong {
    color: var(--vscode-editorWarning-foreground, #d29922);
  }
</style>
