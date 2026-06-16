<script lang="ts">
  // Step 3 — checking / live / partial / error, plus the not-yet-checked fallback.
  import type { TunnelStateMsg, TunnelVerifyState, Route } from "../../types";
  import { ICONS } from "../lib/icons";
  import Spinner from "../shared/Spinner.svelte";
  import VerifyRow from "./VerifyRow.svelte";

  interface Props {
    verifyState: TunnelVerifyState;
    active: TunnelStateMsg | null;
    txtRecordName: string;
    suffix: string;
    wildcardOk: boolean;
    txtOk: boolean;
    bothVerified: boolean;
    canVerify: boolean;
    wildcardResolvedIp: string;
    onVerify: () => void;
    navigate: (r: Route) => void;
  }
  let {
    verifyState, active, txtRecordName, suffix, wildcardOk, txtOk, bothVerified,
    canVerify, wildcardResolvedIp, onVerify, navigate,
  }: Props = $props();

  let wildcardDetail = $derived(
    `${active?.wildcardName ?? ""}${wildcardOk && wildcardResolvedIp ? ` → ${wildcardResolvedIp}` : ""}`,
  );
</script>

{#if verifyState.status === "checking"}
  <span class="tn-field-label">Verify DNS</span>
  <button class="secondary full" disabled><Spinner size={14} label="Checking DNS…" /></button>
  <div class="tn-check-row">
    <Spinner size={13} />
    <span class="tn-check-text">Resolving {active?.wildcardName}</span>
    <span class="tn-check-state">checking</span>
  </div>
  <div class="tn-check-row">
    <Spinner size={13} />
    <span class="tn-check-text">Looking up {txtRecordName} TXT</span>
    <span class="tn-check-state">checking</span>
  </div>
  <div class="tn-hint">DNS changes can take minutes to hours to propagate before they verify.</div>
{:else if verifyState.status === "error"}
  <div class="tn-error-card">
    <div class="tn-error-head"><span class="tn-error-icon">{@html ICONS.close}</span> DNS lookup failed</div>
    <div class="tn-error-sub">Couldn't reach a DNS resolver. Check your network connection and try again.</div>
    {#if verifyState.error}<code class="tn-error-code">{verifyState.error}</code>{/if}
  </div>
  <button class="primary-green full with-icon" onclick={onVerify}>{@html ICONS.refresh} Try again</button>
{:else if bothVerified}
  <!-- Done · Live -->
  <div class="tn-live-card">
    <div class="tn-live-check">{@html ICONS.check}</div>
    <div class="tn-live-title">Tunnel is live</div>
    <div class="tn-live-sub">
      Both DNS records verified for {suffix}. Deployments are now reachable over your domain.
    </div>
  </div>
  <VerifyRow ok title="Wildcard resolves to a relay IP" />
  <VerifyRow ok title="TXT for {txtRecordName} found" />
  <button class="primary-green full with-icon" onclick={() => navigate("deploy")}>{@html ICONS.deployments} Deploy now</button>
  <button class="secondary full with-icon" onclick={onVerify}>{@html ICONS.refresh} Re-check DNS</button>
{:else if verifyState.status === "done"}
  <!-- Partial — some records still propagating -->
  <VerifyRow big ok={wildcardOk} title={wildcardOk ? "Wildcard resolves" : "Wildcard not found yet"} detail={wildcardDetail} />
  <VerifyRow big ok={txtOk} title={txtOk ? "TXT found" : "TXT not found yet"} detail={txtRecordName} />
  <div class="tn-warn-note">
    <span class="tn-warn-icon">{@html ICONS.warning}</span>
    <span>
      DNS can take minutes to hours to propagate. Re-check after a while — and confirm the
      record name is exactly <code>{txtRecordName}</code>.
    </span>
  </div>
  <button class="primary-green full with-icon" onclick={onVerify}>{@html ICONS.refresh} Re-check DNS</button>
{:else}
  <!-- Reached Verify without a check yet (e.g. via the stepper) -->
  <span class="tn-field-label">Verify DNS</span>
  <button class="primary-green full with-icon" onclick={onVerify} disabled={!canVerify}>
    {@html ICONS.shield} Check DNS
  </button>
  <div class="tn-hint">DNS changes can take minutes to hours to propagate before they verify.</div>
{/if}

<style>
  .tn-field-label {
    display: block;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 5px;
  }
  .tn-hint {
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--vscode-descriptionForeground);
    margin-top: 6px;
  }
  .tn-warn-note code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    color: var(--vscode-foreground);
    word-break: break-all;
  }
  .tn-check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }
  .tn-check-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tn-check-state {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }
  .tn-warn-note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 8px 0;
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--vscode-foreground);
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-input-background));
    border: 1px solid var(--vscode-charts-yellow, #cca700);
  }
  .tn-warn-icon {
    flex-shrink: 0;
    display: inline-flex;
    color: var(--vscode-charts-yellow, #cca700);
  }
  .tn-warn-icon :global(svg) {
    width: 15px;
    height: 15px;
  }
  .tn-live-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 20px 16px;
    margin-bottom: 10px;
    border-radius: 12px;
    background: var(--acu-live-bg);
    border: 1.5px solid var(--acu-live-border);
  }
  .tn-live-check {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    margin-bottom: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--acu-green);
    color: var(--acu-on-accent);
  }
  .tn-live-check :global(svg) {
    width: 26px;
    height: 26px;
  }
  .tn-live-title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 5px;
  }
  .tn-live-sub {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--acu-live-fg);
    max-width: 280px;
  }
  .tn-error-card {
    padding: 12px;
    margin-bottom: 10px;
    border-radius: 10px;
    background: var(--vscode-inputValidation-errorBackground, var(--vscode-input-background));
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }
  .tn-error-head {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-errorForeground);
  }
  .tn-error-icon {
    display: inline-flex;
  }
  .tn-error-icon :global(svg) {
    width: 15px;
    height: 15px;
  }
  .tn-error-sub {
    font-size: 11px;
    line-height: 1.5;
    color: var(--vscode-foreground);
    margin: 6px 0 0;
  }
  .tn-error-code {
    display: block;
    margin-top: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    color: var(--vscode-errorForeground);
    background: var(--vscode-editor-background);
    word-break: break-all;
  }
</style>
