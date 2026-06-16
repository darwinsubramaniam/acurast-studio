<script lang="ts">
  import type { TunnelStateMsg, AcurastNetwork, WalletInfo } from "../../types";
  import { onDestroy } from "svelte";
  import { send } from "../lib/vscode";
  import { truncate } from "../lib/format";

  interface Props {
    tunnel: TunnelStateMsg | null;
    wallets: { list: WalletInfo[]; activeId: string | null };
  }
  let { tunnel, wallets }: Props = $props();

  // Local, immediate input state. Seeded once from the host so its echo (which
  // normalizes the suffix and resolves the default wallet) never fights the caret.
  // After seeding, all three stay user-controlled — later host echoes are ignored
  // by design (the selections made here are the source of truth, not a bug).
  let suffix = $state("");
  let network = $state<AcurastNetwork>("canary");
  let selectedWalletId = $state("");
  let seeded = $state(false);

  $effect(() => {
    if (tunnel && !seeded) {
      suffix = tunnel.suffix;
      network = tunnel.network;
      selectedWalletId = tunnel.selectedWalletId ?? wallets.activeId ?? "";
      seeded = true;
    }
  });

  let debounce: ReturnType<typeof setTimeout> | undefined;
  function onSuffixInput() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(
      () => send("tunnel.compute", { suffix, network, walletId: selectedWalletId }),
      250,
    );
  }
  // Cancel any pending suffix-debounce on teardown so a stale tunnel.compute
  // can't fire after the view unmounts.
  onDestroy(() => {
    if (debounce) clearTimeout(debounce);
  });
  function onNetworkChange() {
    send("tunnel.compute", { suffix, network, walletId: selectedWalletId });
  }
  function onWalletChange() {
    send("tunnel.compute", { suffix, network, walletId: selectedWalletId });
  }
  function verify() {
    send("tunnel.verify", { suffix, network, walletId: selectedWalletId });
  }
  function copy(text: string) {
    send("deploy.copy", { text });
  }

  let hasSuffix = $derived(suffix.trim().length > 0);
  let relays = $derived(tunnel?.relays ?? []);
  // The host only fills these once a suffix is set (wildcardName is '' otherwise).
  let active = $derived(tunnel && tunnel.wildcardName ? tunnel : null);
  let rec = $derived(active?.record ?? null);
  let txtRecordName = $derived(active?.txtName ?? "");
  let walletOptions = $derived(wallets.list);
  let verifyState = $derived(tunnel?.verify ?? { status: "idle" as const });
  let netLabel = $derived(network === "mainnet" ? "Mainnet" : "Canary");
</script>

<p class="intro">
  Every tunnel deployment is served at
  <code>{active?.publicUrlExample ?? "https://<clientId>.<suffix>:8443"}</code>.
  Pick a subdomain you control, then add the two records below at your DNS
  provider. The values are computed for you — no terminal, OpenSSL or hex
  conversion, and identical on macOS, Windows and Linux.
</p>

<div class="field">
  <label for="tunnel-network">Network</label>
  <select id="tunnel-network" bind:value={network} onchange={onNetworkChange}>
    <option value="canary">Canary</option>
    <option value="mainnet">Mainnet</option>
  </select>
</div>

<div class="field">
  <label for="tunnel-suffix">Your domain suffix</label>
  <input
    id="tunnel-suffix"
    type="text"
    placeholder="tunnel.example.com"
    bind:value={suffix}
    oninput={onSuffixInput}
    spellcheck="false"
    autocapitalize="off"
    autocomplete="off"
  />
  <div class="hint">
    The relay routes <code>&lt;clientId&gt;.{suffix.trim() || "<suffix>"}</code> to your
    deployment.
  </div>
</div>

<!-- Record 1: wildcard A records -->
<div class="section">
  <div class="section-title">Record 1 — Wildcard A records</div>
  {#if !hasSuffix}
    <div class="empty">Enter a domain suffix above to generate records.</div>
  {:else if relays.length === 0}
    <div class="empty">
      No relay nodes are configured for {netLabel}. Add IPs via the
      <code>acurast.tunnelRelays</code> setting to enable this network.
    </div>
  {:else if active}
    <p class="rec-note">
      Point <code>{active.wildcardName}</code> at every relay IP (one A record per
      IP, all sharing this name):
    </p>
    <div class="rec-row">
      <span class="rec-field-label">Name</span>
      <code class="rec-text">{active.wildcardName}</code>
      <button class="rec-copy" onclick={() => copy(active.wildcardName)}>Copy</button>
    </div>
    <div class="rec-row">
      <span class="rec-field-label">Type</span>
      <code class="rec-text">A</code>
    </div>
    {#each relays as r (r.ip)}
      <div class="rec-row">
        <span class="rec-field-label">Value</span>
        <code class="rec-text">{r.ip}</code>
        <button class="rec-copy" onclick={() => copy(r.ip)}>Copy</button>
      </div>
      <div class="rec-host">{r.host}</div>
    {/each}
  {/if}
</div>

<!-- Record 2: TXT ownership proof -->
<div class="section">
  <div class="section-title">Record 2 — TXT ownership proof</div>
  {#if !hasSuffix}
    <div class="empty">Enter a domain suffix above to generate the TXT value.</div>
  {:else if walletOptions.length === 0}
    <div class="empty">No wallets yet. Create or import a wallet to generate a TXT record.</div>
  {:else if rec}
    <div class="field">
      <label for="tunnel-wallet">Deployer wallet</label>
      <select id="tunnel-wallet" bind:value={selectedWalletId} onchange={onWalletChange}>
        {#each walletOptions as w (w.id)}
          <option value={w.id}>{w.name}{w.id === wallets.activeId ? " (active)" : ""}</option>
        {/each}
      </select>
      <div class="hint">The account that will submit deployments under this suffix.</div>
    </div>

    <p class="rec-note">
      Add a TXT record at <code>{txtRecordName}</code> proving this wallet
      controls the suffix.
    </p>
    <div class="rec-row">
      <span class="rec-field-label">Name</span>
      <code class="rec-text">{txtRecordName}</code>
      <button class="rec-copy" onclick={() => copy(txtRecordName)}>Copy</button>
    </div>
    <div class="txt-card">
      <div class="txt-head">
        <span class="txt-name">{rec.name}</span>
        {#if rec.verified === true}
          <span class="ok-badge">verified</span>
        {:else if rec.verified === false}
          <span class="miss-badge">missing</span>
        {/if}
      </div>
      <div class="txt-addr">{truncate(rec.address, 12)}</div>
      <div class="rec-row">
        <span class="rec-field-label">Value</span>
        <code class="rec-text">{rec.txtValue}</code>
        <button class="rec-copy" onclick={() => copy(rec.txtValue)}>Copy</button>
      </div>
    </div>
    <div class="hint">
      Deploying from more than one account? Switch the wallet above and add each
      one's TXT record — the relay accepts any matching record.
    </div>
  {/if}
</div>

<!-- Verify -->
{#if hasSuffix}
  <div class="section">
    <div class="section-title">Verify DNS</div>
    <button
      class="secondary full"
      onclick={verify}
      disabled={verifyState.status === "checking"}
    >
      {verifyState.status === "checking" ? "Checking…" : "Check DNS"}
    </button>
    <div class="hint">
      DNS changes can take minutes to hours to propagate before they verify.
    </div>

    {#if verifyState.status === "error"}
      <div class="error-hint">{verifyState.error}</div>
    {:else if verifyState.status === "done"}
      {#if verifyState.wildcard}
        <div class="verify-row">
          <span class={verifyState.wildcard.ok ? "ok-mark" : "fail-mark"}>
            {verifyState.wildcard.ok ? "✓" : "✗"}
          </span>
          <span>
            {#if verifyState.wildcard.ok}
              Wildcard resolves to a relay IP.
            {:else if verifyState.wildcard.resolvedIps.length === 0}
              Wildcard — no A record found yet.
            {:else}
              Wildcard resolves to {verifyState.wildcard.resolvedIps.join(", ")} (expected
              a relay IP).
            {/if}
          </span>
        </div>
      {/if}
      {#if rec}
        <div class="verify-row">
          <span class={rec.verified ? "ok-mark" : "fail-mark"}>{rec.verified ? "✓" : "✗"}</span>
          <span>TXT for {rec.name} {rec.verified ? "found." : "not found."}</span>
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .intro {
    font-size: 12px;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground);
    margin: 4px 0 12px;
  }
  .intro code,
  .hint code,
  .rec-note code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-foreground);
    word-break: break-all;
  }
  .rec-note {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 8px;
    line-height: 1.45;
  }
  .rec-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 0;
  }
  .rec-field-label {
    flex-shrink: 0;
    width: 42px;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
  }
  .rec-text {
    flex: 1;
    min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    padding: 5px 7px;
    background: var(--vscode-input-background);
    border-radius: 2px;
    overflow-x: auto;
    white-space: nowrap;
  }
  .rec-copy {
    flex-shrink: 0;
    padding: 3px 8px;
    font-size: 10px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  .rec-copy:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .rec-host {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    margin: 1px 0 6px 48px;
  }
  .txt-card {
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
    padding: 8px 10px;
    margin: 6px 0;
    background: var(--vscode-editor-background);
  }
  .txt-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .txt-name {
    font-weight: 600;
    font-size: 12px;
  }
  .txt-addr {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin: 2px 0 2px;
  }
  .ok-badge,
  .miss-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 2px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .ok-badge {
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    color: var(--vscode-editor-background);
  }
  .miss-badge {
    background: var(--vscode-errorForeground);
    color: var(--vscode-editor-background);
  }
  .verify-row {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 11px;
    margin-top: 4px;
  }
  .ok-mark {
    color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    font-weight: 700;
  }
  .fail-mark {
    color: var(--vscode-errorForeground);
    font-weight: 700;
  }
</style>
