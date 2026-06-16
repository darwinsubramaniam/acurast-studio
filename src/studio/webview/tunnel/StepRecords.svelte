<script lang="ts">
  // Step 2 — the two DNS records, plus the no-relays / no-wallet edge states.
  import type { TunnelStateMsg, TunnelVerifyState, AcurastNetwork, WalletInfo, TunnelRelay, Route } from "../../types";
  import { send } from "../lib/vscode";
  import { ICONS } from "../lib/icons";
  import { wildcardBadge, txtBadge } from "./status";
  import CopyRow from "./CopyRow.svelte";

  interface Props {
    active: TunnelStateMsg | null;
    rec: TunnelStateMsg["record"];
    relays: TunnelRelay[];
    txtRecordName: string;
    walletOptions: WalletInfo[];
    activeWalletId: string | null;
    selectedWalletId: string;
    network: AcurastNetwork;
    netLabel: string;
    verifyState: TunnelVerifyState;
    canVerify: boolean;
    onWalletChange: (id: string) => void;
    onNetwork: (n: AcurastNetwork) => void;
    onVerify: () => void;
    navigate: (r: Route) => void;
  }
  let {
    active, rec, relays, txtRecordName, walletOptions, activeWalletId, selectedWalletId,
    network, netLabel, verifyState, canVerify, onWalletChange, onNetwork, onVerify, navigate,
  }: Props = $props();

  // Wildcard A list collapses to the first 3 relays with a "+N more" expander.
  let showAllRelays = $state(false);
  let displayedRelays = $derived(showAllRelays ? relays : relays.slice(0, 3));

  let verifyDone = $derived(verifyState.status === "done");
  let wildBadge = $derived(wildcardBadge(verifyDone, !!verifyState.wildcard?.ok));
  let txtBdg = $derived(txtBadge(verifyDone, rec?.verified === true));
</script>

<p class="tn-intro">Add these two records at your DNS provider — values are computed for you.</p>

{#if relays.length === 0}
  <!-- Edge: no relays for this network -->
  <div class="tn-rec-card">
    <div class="tn-rec-head">
      <span class="tn-rec-type a">A</span>
      <span class="tn-rec-title">Wildcard · A records</span>
    </div>
    <div class="tn-edge warn">
      <div class="tn-edge-icon warn">{@html ICONS.warning}</div>
      <div class="tn-edge-title">No relay nodes for {netLabel}</div>
      <div class="tn-edge-sub">
        {netLabel} has no built-in relays yet. Add relay IPs via the
        <code>acurast.tunnelRelays</code> setting to generate the wildcard A records for this network.
      </div>
      <div class="tn-edge-actions">
        <button class="secondary with-icon" onclick={() => send("tunnel.openRelaySetting")}>
          {@html ICONS.settings} Open setting
        </button>
        {#if network !== "canary"}
          <button class="primary-green" onclick={() => onNetwork("canary")}>Use Canary</button>
        {/if}
      </div>
    </div>
  </div>
{:else if walletOptions.length === 0}
  <!-- Edge: relays ready, but no wallet to sign the TXT proof -->
  <div class="tn-ready-row"><span class="tn-ready-mark">{@html ICONS.check}</span> Wildcard A records ready</div>
  <div class="tn-rec-card">
    <div class="tn-rec-head">
      <span class="tn-rec-type txt">TXT</span>
      <span class="tn-rec-title">Ownership proof</span>
    </div>
    <div class="tn-edge">
      <div class="tn-edge-icon">{@html ICONS.lock}</div>
      <div class="tn-edge-title">No wallet to sign with</div>
      <div class="tn-edge-sub">
        Create or import a wallet to compute the TXT ownership proof for this suffix.
      </div>
      <div class="tn-edge-actions">
        <button class="primary-green with-icon" onclick={() => navigate("wallets")}>
          {@html ICONS.plus} Create wallet
        </button>
        <button class="secondary with-icon" onclick={() => navigate("wallets")}>
          {@html ICONS.importIcon} Import phrase
        </button>
      </div>
    </div>
  </div>
{:else}
  <!-- Wildcard A records -->
  <div class="tn-rec-card">
    <div class="tn-rec-head">
      <span class="tn-rec-type a">A</span>
      <span class="tn-rec-title">Wildcard</span>
      <span class="tn-rec-badge {wildBadge.cls}">{wildBadge.label}</span>
    </div>
    <div class="tn-rec-field-label">Host</div>
    <CopyRow value={active?.wildcardName ?? ""} />
    <div class="tn-rec-field-label">Value · one A record per relay IP</div>
    {#each displayedRelays as r (r.ip)}
      <CopyRow value={r.ip} host={r.host} />
    {/each}
    <div class="tn-rec-foot">
      {#if relays.length > 3}
        <button class="tn-link" onclick={() => (showAllRelays = !showAllRelays)}>
          {showAllRelays ? "Show fewer" : `+${relays.length - 3} more relay IPs`}
        </button>
      {:else}
        <span></span>
      {/if}
      <button class="secondary with-icon tn-copyall" onclick={() => send("deploy.copy", { text: relays.map((r) => r.ip).join("\n") })}>
        {@html ICONS.copy} Copy all
      </button>
    </div>
  </div>

  <!-- TXT ownership proof -->
  <div class="tn-rec-card">
    <div class="tn-rec-head">
      <span class="tn-rec-type txt">TXT</span>
      <span class="tn-rec-title">Ownership proof</span>
      <span class="tn-rec-badge {txtBdg.cls}">{txtBdg.label}</span>
    </div>
    <label class="tn-rec-field-label" for="tn-wallet">Deployer wallet</label>
    <select id="tn-wallet" value={selectedWalletId} onchange={(e) => onWalletChange(e.currentTarget.value)}>
      {#each walletOptions as w (w.id)}
        <option value={w.id}>{w.name}{w.id === activeWalletId ? " (active)" : ""}</option>
      {/each}
    </select>
    {#if rec}
      <div class="tn-rec-field-label">Host</div>
      <CopyRow value={txtRecordName} />
      <div class="tn-rec-field-label">Value · base64( sha256( pubkey · suffix ) )</div>
      <CopyRow value={rec.txtValue} wrap />
    {/if}
    <div class="tn-hint">
      Deploying from more than one account? Switch the wallet above and add each one's TXT —
      the relay accepts any matching record.
    </div>
  </div>
{/if}

{#if canVerify}
  <button class="primary-green full with-icon" onclick={onVerify}>{@html ICONS.shield} Verify DNS</button>
{/if}

<style>
  .tn-intro {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 10px;
  }
  .tn-hint {
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--vscode-descriptionForeground);
    margin-top: 6px;
  }
  .tn-rec-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 10px;
    padding: 12px;
    margin: 0 0 10px;
  }
  .tn-rec-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .tn-rec-type {
    flex-shrink: 0;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .tn-rec-type.a {
    background: var(--acu-accent-soft-bg);
    color: var(--acu-accent-soft-fg);
  }
  .tn-rec-type.txt {
    background: var(--vscode-input-background);
    color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
  }
  .tn-rec-title {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
  }
  .tn-rec-badge {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 7px;
    border-radius: 999px;
  }
  .tn-rec-badge.pending {
    background: var(--vscode-input-background);
    color: var(--vscode-descriptionForeground);
  }
  .tn-rec-badge.miss {
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-input-background));
    color: var(--vscode-charts-yellow, #cca700);
  }
  .tn-rec-badge.ok {
    background: var(--acu-accent-soft-bg);
    color: var(--acu-accent-soft-fg);
  }
  .tn-rec-field-label {
    display: block;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin: 10px 0 4px;
  }
  .tn-rec-field-label:first-of-type {
    margin-top: 0;
  }
  .tn-rec-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }
  .tn-link {
    padding: 0;
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-textLink-foreground);
  }
  .tn-link:hover {
    background: transparent;
    text-decoration: underline;
  }
  .tn-copyall {
    padding: 4px 10px;
    font-size: 11px;
  }
  .tn-edge {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 14px 12px;
    border-radius: 8px;
    background: var(--vscode-input-background);
  }
  .tn-edge.warn {
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-input-background));
    border: 1px solid var(--vscode-charts-yellow, #cca700);
  }
  .tn-edge-icon {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    margin-bottom: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
  }
  .tn-edge-icon.warn {
    color: var(--vscode-charts-yellow, #cca700);
  }
  .tn-edge-icon :global(svg) {
    width: 20px;
    height: 20px;
  }
  .tn-edge-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .tn-edge-sub {
    font-size: 11px;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground);
    max-width: 280px;
    margin-bottom: 12px;
  }
  .tn-edge-sub code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    color: var(--vscode-foreground);
    word-break: break-all;
  }
  .tn-edge-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .tn-ready-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 10px;
    padding: 10px 12px;
    font-size: 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 10px;
  }
  .tn-ready-mark {
    flex-shrink: 0;
    display: inline-flex;
    color: var(--acu-accent-soft-fg);
  }
  .tn-ready-mark :global(svg) {
    width: 16px;
    height: 16px;
  }
</style>
