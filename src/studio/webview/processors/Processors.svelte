<script lang="ts">
  import type {
    WalletInfo,
    ProcessorsStateMsg,
    ManagedProcessor,
  } from "../../types";
  import { send } from "../lib/vscode";
  import { ICONS } from "../lib/icons";
  import { planckToAcu, fmtRelative, fmtTimestamp, truncate } from "../lib/format";
  import Spinner from "../shared/Spinner.svelte";

  interface Props {
    wallets: {
      list: WalletInfo[];
      activeId: string | null;
      network: string;
      symbol: string;
    };
    processorsState: ProcessorsStateMsg | null;
  }
  let { wallets, processorsState }: Props = $props();

  // Currently-selected wallet address to inspect.
  let selected = $state<string | null>(null);

  // Module names the marketplace understands. Order here drives chip order.
  const ALL_MODULES: string[] = ["DataEncryption", "LLM", "Shell"];

  // Per-processor draft module set, keyed by processor address. Absent = no edit.
  let edits = $state<Record<string, string[]>>({});
  // Processor address whose advertiseFor tx is currently in flight.
  let applying = $state<string | null>(null);

  // Whenever a fresh query result arrives, drop drafts and clear the in-flight
  // flag so cards re-baseline against the latest on-chain module set.
  $effect(() => {
    void processorsState;
    edits = {};
    applying = null;
    adFormFor = null;
  });

  function walletName(addr: string): string {
    return wallets.list.find((w) => w.address === addr)?.name || truncate(addr);
  }

  function walletIdFor(addr: string | null): string | null {
    return addr ? (wallets.list.find((w) => w.address === addr)?.id ?? null) : null;
  }

  function modulesOf(p: ManagedProcessor): string[] {
    return edits[p.address] ?? p.ad?.availableModules ?? [];
  }

  function toggleModule(p: ManagedProcessor, m: string) {
    const set = new Set(modulesOf(p));
    if (set.has(m)) set.delete(m);
    else set.add(m);
    edits = { ...edits, [p.address]: ALL_MODULES.filter((x) => set.has(x)) };
  }

  function resetEdit(p: ManagedProcessor) {
    const { [p.address]: _drop, ...rest } = edits;
    edits = rest;
  }

  function moduleChanged(p: ManagedProcessor): boolean {
    const orig = [...(p.ad?.availableModules ?? [])].sort().join(",");
    const cur = [...modulesOf(p)].sort().join(",");
    return orig !== cur;
  }

  function applyModules(p: ManagedProcessor) {
    const walletId = walletIdFor(selected);
    if (!walletId) return;
    applying = p.address;
    send("processors.advertise", {
      walletId,
      processor: p.address,
      // Snapshot to a plain array — a $state proxy can't be structured-cloned by postMessage.
      modules: $state.snapshot(modulesOf(p)),
      network: wallets.network,
    });
  }

  // ── Start-advertising form (processors with no on-chain advertisement) ──
  // Address of the processor whose form is open; null = closed. Only one form
  // can be open at a time, so a single draft object is enough.
  let adFormFor = $state<string | null>(null);
  let adForm = $state({
    modules: [] as string[],
    feePerMillisecond: "1",
    feePerStorageByte: "1",
    baseFeePerExecution: "0",
    availableDays: 30,
    maxMemory: 100_000_000,
    storageCapacity: 100_000_000,
    networkRequestQuota: 100,
  });

  function openAdForm(p: ManagedProcessor) {
    // Prefill from a sibling that already advertises — same fleet, so its
    // pricing/capacities are the best available guess; else modest defaults.
    const t = processors.find((x) => x.advertising && x.ad && x.pricing);
    adForm = {
      modules: ALL_MODULES.filter((m) => t?.ad?.availableModules?.includes(m)),
      feePerMillisecond: t?.pricing?.feePerMillisecond ?? "1",
      feePerStorageByte: t?.pricing?.feePerStorageByte ?? "1",
      baseFeePerExecution: t?.pricing?.baseFeePerExecution ?? "0",
      availableDays: 30,
      maxMemory: t?.ad?.maxMemory ?? 100_000_000,
      storageCapacity: t?.ad?.storageCapacity ?? 100_000_000,
      networkRequestQuota: t?.ad?.networkRequestQuota ?? 100,
    };
    adFormFor = p.address;
  }

  function toggleFormModule(m: string) {
    const set = new Set(adForm.modules);
    if (set.has(m)) set.delete(m);
    else set.add(m);
    adForm.modules = ALL_MODULES.filter((x) => set.has(x));
  }

  // Fees are u128 on chain — validate as unsigned-integer planck strings.
  function uintStr(v: string): boolean {
    return /^\d+$/.test(v.trim());
  }

  let adFormValid = $derived(
    uintStr(adForm.feePerMillisecond) &&
      uintStr(adForm.feePerStorageByte) &&
      uintStr(adForm.baseFeePerExecution) &&
      Number.isInteger(adForm.availableDays) &&
      adForm.availableDays > 0 &&
      Number.isInteger(adForm.maxMemory) &&
      adForm.maxMemory >= 0 &&
      Number.isInteger(adForm.storageCapacity) &&
      adForm.storageCapacity >= 0 &&
      Number.isInteger(adForm.networkRequestQuota) &&
      adForm.networkRequestQuota >= 0 &&
      adForm.networkRequestQuota <= 255,
  );

  function startAdvertising(p: ManagedProcessor) {
    const walletId = walletIdFor(selected);
    if (!walletId || !adFormValid) return;
    applying = p.address;
    send("processors.advertise", {
      walletId,
      processor: p.address,
      modules: $state.snapshot(adForm.modules),
      network: wallets.network,
      newAd: {
        feePerMillisecond: adForm.feePerMillisecond.trim(),
        feePerStorageByte: adForm.feePerStorageByte.trim(),
        baseFeePerExecution: adForm.baseFeePerExecution.trim(),
        schedulingWindowEnd: Date.now() + adForm.availableDays * 86_400_000,
        maxMemory: adForm.maxMemory,
        storageCapacity: adForm.storageCapacity,
        networkRequestQuota: adForm.networkRequestQuota,
      },
    });
  }

  // Network the current selection was last queried under, so we can re-query
  // when the user switches the target network.
  let queriedNetwork = $state<string | null>(null);

  function query(address: string) {
    selected = address;
    queriedNetwork = wallets.network;
    send("processors.query", { address, network: wallets.network });
  }

  // Re-query when the target network changes while a wallet is selected, so the
  // list never shows processors from the previously-targeted network.
  $effect(() => {
    const net = wallets.network;
    if (selected && queriedNetwork !== null && net !== queriedNetwork) {
      query(selected);
    }
  });

  // Auto-select when there's exactly one wallet; otherwise let the user pick.
  // Runs once wallets arrive — guarded by `selected` so it doesn't re-fire.
  $effect(() => {
    if (selected) return;
    if (wallets.list.length === 1) query(wallets.list[0].address);
  });

  // Only treat state as ours when it matches the wallet we asked about,
  // so switching wallets never shows stale results.
  let live = $derived(
    processorsState && processorsState.address === selected
      ? processorsState
      : null,
  );
  let status = $derived(live?.status ?? (selected ? "loading" : "idle"));
  let processors = $derived<ManagedProcessor[]>(live?.result?.processors ?? []);

  const ONLINE_MS = 60 * 60 * 1000; // ≤ 1h → online
  const IDLE_MS = 24 * 60 * 60 * 1000; // ≤ 24h → idle

  function presence(lastSeen: number): { dot: string; label: string } {
    if (!lastSeen) return { dot: "off", label: "Never seen" };
    const diff = Date.now() - lastSeen;
    if (diff <= ONLINE_MS) return { dot: "on", label: "Online" };
    if (diff <= IDLE_MS) return { dot: "idle", label: "Idle" };
    return { dot: "off", label: "Offline" };
  }

  const PLATFORMS: Record<number, string> = { 0: "Android", 1: "iOS" };
  function platformLabel(p: number | undefined): string {
    if (p === undefined) return "Unknown";
    return PLATFORMS[p] ?? `Platform ${p}`;
  }

  function reputation(p: ManagedProcessor): string {
    const rep = p.reputation;
    if (!rep) return "—";
    const total = rep.r + rep.s;
    if (total <= 0) return "New";
    return `${Math.round((rep.r / total) * 100)}%`;
  }

  let onlineCount = $derived(
    processors.filter((p) => presence(p.lastSeen).dot === "on").length,
  );
</script>

<div class="proc-wrap">
  {#if wallets.list.length === 0}
    <div class="empty">
      <span class="big-icon">{@html ICONS.wallet}</span>
      <p>No wallets yet. Create or import a wallet to check for paired processors.</p>
    </div>
  {:else}
    <!-- Wallet selector (only shown when there's a choice to make) -->
    {#if wallets.list.length > 1}
      <div class="picker">
        <div class="picker-label">Select a wallet to inspect</div>
        <div class="picker-grid">
          {#each wallets.list as w (w.id)}
            <button
              class="picker-card"
              class:active={selected === w.address}
              onclick={() => query(w.address)}
            >
              <span class="icon">{@html ICONS.wallet}</span>
              <div class="body">
                <div class="title">
                  {w.name || "Unnamed"}
                  {#if w.id === wallets.activeId}<span class="badge">active</span>{/if}
                </div>
                <div class="sub">{truncate(w.address)}</div>
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if selected}
      <div class="selected-bar">
        <span class="dim">Manager wallet</span>
        <span class="addr">{walletName(selected)}</span>
        <button
          class="ghost"
          title="Re-check"
          onclick={() => query(selected!)}
          disabled={status === "loading"}
        >
          {@html ICONS.refresh}
        </button>
      </div>

      {#if status === "loading"}
        <div class="note">
          <Spinner size={12} label="Querying the chain for paired processors…" />
        </div>
      {:else if status === "error"}
        <div class="note error">{live?.error ?? "Failed to load processors."}</div>
      {:else if processors.length === 0}
        <div class="empty">
          <span class="big-icon">{@html ICONS.processor}</span>
          <p>No processors are paired to this wallet.</p>
          <span class="dim">
            Pair a device in the Acurast app using this wallet as its manager.
          </span>
        </div>
      {:else}
        <div class="summary">
          <strong>{processors.length}</strong>
          processor{processors.length === 1 ? "" : "s"} paired
          <span class="dot-sep">·</span>
          <span class="on-text">{onlineCount} online</span>
        </div>

        <div class="cards">
          {#each processors as p (p.address)}
            {@const pr = presence(p.lastSeen)}
            <div class="proc-card">
              <div class="head">
                <span class="status {pr.dot}" title={pr.label}></span>
                <span class="paddr" title={p.address}>{truncate(p.address)}</span>
                <button
                  class="ghost copy"
                  title="Copy address"
                  onclick={() => send("deploy.copy", { text: p.address })}
                >
                  {@html ICONS.importIcon}
                </button>
                <span class="presence {pr.dot}">{pr.label}</span>
              </div>

              <div class="grid">
                <div class="cell">
                  <span class="k">Last seen</span>
                  <span class="v">{fmtRelative(p.lastSeen)}</span>
                </div>
                <div class="cell">
                  <span class="k">Version</span>
                  <span class="v">{p.version ?? "—"}</span>
                </div>
                <div class="cell">
                  <span class="k">Platform</span>
                  <span class="v">{platformLabel(p.platform)}</span>
                </div>
                <div class="cell">
                  <span class="k">Reputation</span>
                  <span class="v">{reputation(p)}</span>
                </div>
              </div>

              {#if p.advertising && p.ad}
                <div class="section">
                  <div class="section-head">
                    <span class="adv-badge">Advertising</span>
                    {#if p.ad.allowedConsumers && p.ad.allowedConsumers.length}
                      <span class="vis private" title={p.ad.allowedConsumers.join("\n")}>
                        Private · {p.ad.allowedConsumers.length} consumer{p.ad.allowedConsumers.length === 1 ? "" : "s"}
                      </span>
                    {:else}
                      <span class="vis public">Public</span>
                    {/if}
                  </div>

                  <div class="modules-edit">
                    <span class="me-label">Modules</span>
                    <div class="chips">
                      {#each ALL_MODULES as m}
                        {@const on = modulesOf(p).includes(m)}
                        <button
                          type="button"
                          class="chip toggle"
                          class:on
                          disabled={applying === p.address}
                          title={on
                            ? `Click to stop advertising ${m}`
                            : `Click to advertise ${m}`}
                          onclick={() => toggleModule(p, m)}
                        >
                          {#if on}<span class="tick">✓</span>{/if}{m}
                        </button>
                      {/each}
                    </div>
                    {#if moduleChanged(p)}
                      <div class="apply-row">
                        <span class="hint">
                          Pending: {modulesOf(p).join(", ") || "(none)"}
                        </span>
                        <button
                          type="button"
                          class="link"
                          disabled={applying === p.address}
                          onclick={() => resetEdit(p)}>Reset</button
                        >
                        <button
                          type="button"
                          class="apply"
                          disabled={applying === p.address || !walletIdFor(selected)}
                          onclick={() => applyModules(p)}
                        >
                          {#if applying === p.address}
                            <Spinner size={10} label="Advertising…" />
                          {:else}
                            Apply on-chain
                          {/if}
                        </button>
                      </div>
                    {/if}
                  </div>

                  <div class="grid">
                    <div class="cell">
                      <span class="k">Max memory</span>
                      <span class="v">{p.ad.maxMemory?.toLocaleString() ?? "—"}</span>
                    </div>
                    <div class="cell">
                      <span class="k">Storage</span>
                      <span class="v">{p.ad.storageCapacity?.toLocaleString() ?? "—"}</span>
                    </div>
                    <div class="cell">
                      <span class="k">Net quota</span>
                      <span class="v">{p.ad.networkRequestQuota ?? "—"}</span>
                    </div>
                  </div>
                </div>

                {#if p.pricing}
                  <div class="section">
                    <div class="grid">
                      <div class="cell">
                        <span class="k">Base fee / run</span>
                        <span class="v"
                          >{planckToAcu(p.pricing.baseFeePerExecution)}
                          {wallets.symbol}</span
                        >
                      </div>
                      <div class="cell">
                        <span class="k">Fee / ms</span>
                        <span class="v">{p.pricing.feePerMillisecond ?? "—"} planck</span>
                      </div>
                      <div class="cell">
                        <span class="k">Fee / byte</span>
                        <span class="v">{p.pricing.feePerStorageByte ?? "—"} planck</span>
                      </div>
                      {#if p.pricing.schedulingWindowEnd}
                        <div class="cell">
                          <span class="k">Avail. until</span>
                          <span class="v">{fmtTimestamp(p.pricing.schedulingWindowEnd)}</span>
                        </div>
                      {/if}
                    </div>
                  </div>
                {/if}
              {:else}
                <div class="not-advertising">
                  Not currently advertising on the marketplace.
                </div>
                {#if adFormFor === p.address}
                  <div class="section ad-form">
                    <div class="modules-edit">
                      <span class="me-label">Modules</span>
                      <div class="chips">
                        {#each ALL_MODULES as m}
                          {@const on = adForm.modules.includes(m)}
                          <button
                            type="button"
                            class="chip toggle"
                            class:on
                            disabled={applying === p.address}
                            title={on
                              ? `Click to stop advertising ${m}`
                              : `Click to advertise ${m}`}
                            onclick={() => toggleFormModule(m)}
                          >
                            {#if on}<span class="tick">✓</span>{/if}{m}
                          </button>
                        {/each}
                      </div>
                    </div>

                    <div class="form-grid">
                      <label class="cell">
                        <span class="k">Fee / ms (planck)</span>
                        <input
                          type="text"
                          bind:value={adForm.feePerMillisecond}
                          disabled={applying === p.address}
                        />
                      </label>
                      <label class="cell">
                        <span class="k">Fee / byte (planck)</span>
                        <input
                          type="text"
                          bind:value={adForm.feePerStorageByte}
                          disabled={applying === p.address}
                        />
                      </label>
                      <label class="cell">
                        <span class="k">Base fee / run (planck)</span>
                        <input
                          type="text"
                          bind:value={adForm.baseFeePerExecution}
                          disabled={applying === p.address}
                        />
                      </label>
                      <label class="cell">
                        <span class="k">Available for (days)</span>
                        <input
                          type="number"
                          min="1"
                          bind:value={adForm.availableDays}
                          disabled={applying === p.address}
                        />
                      </label>
                      <label class="cell">
                        <span class="k">Max memory (bytes)</span>
                        <input
                          type="number"
                          min="0"
                          bind:value={adForm.maxMemory}
                          disabled={applying === p.address}
                        />
                      </label>
                      <label class="cell">
                        <span class="k">Storage (bytes)</span>
                        <input
                          type="number"
                          min="0"
                          bind:value={adForm.storageCapacity}
                          disabled={applying === p.address}
                        />
                      </label>
                      <label class="cell">
                        <span class="k">Net quota</span>
                        <input
                          type="number"
                          min="0"
                          max="255"
                          bind:value={adForm.networkRequestQuota}
                          disabled={applying === p.address}
                        />
                      </label>
                    </div>

                    <div class="apply-row">
                      <span class="hint">Published as a public advertisement.</span>
                      <button
                        type="button"
                        class="link"
                        disabled={applying === p.address}
                        onclick={() => (adFormFor = null)}>Cancel</button
                      >
                      <button
                        type="button"
                        class="apply"
                        disabled={applying === p.address ||
                          !adFormValid ||
                          !walletIdFor(selected)}
                        onclick={() => startAdvertising(p)}
                      >
                        {#if applying === p.address}
                          <Spinner size={10} label="Publishing…" />
                        {:else}
                          Advertise on-chain
                        {/if}
                      </button>
                    </div>
                  </div>
                {:else}
                  <div class="apply-row">
                    <button
                      type="button"
                      class="apply"
                      disabled={applying === p.address || !walletIdFor(selected)}
                      onclick={() => openAdForm(p)}
                    >
                      Start advertising
                    </button>
                  </div>
                {/if}
              {/if}

              <div class="foot">
                <span class="dim">Manager NFT</span>
                <span class="mid">#{p.managerId}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="note dim">Pick a wallet above to look up its processors.</div>
    {/if}
  {/if}
</div>

<style>
  .proc-wrap {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .picker-label,
  .summary,
  .selected-bar {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .picker-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }
  .picker-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    text-align: left;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    cursor: pointer;
    color: inherit;
  }
  .picker-card:hover {
    border-color: var(--vscode-focusBorder);
  }
  .picker-card.active {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-activeSelectionBackground, rgba(0, 122, 204, 0.1));
  }
  .picker-card .icon :global(svg) {
    width: 18px;
    height: 18px;
    opacity: 0.8;
  }
  .picker-card .title {
    font-size: 13px;
    font-weight: 600;
  }
  .picker-card .sub {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .selected-bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .selected-bar .addr {
    font-weight: 600;
    color: var(--vscode-foreground);
  }
  .selected-bar .ghost {
    margin-left: auto;
  }

  .summary {
    color: var(--vscode-foreground);
  }
  .summary strong {
    font-size: 14px;
  }
  .dot-sep {
    margin: 0 4px;
    opacity: 0.5;
  }
  .on-text {
    color: var(--vscode-testing-iconPassed, #3fb950);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .proc-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
  }
  .status.on,
  .presence.on {
    color: var(--vscode-testing-iconPassed, #3fb950);
  }
  .status.on {
    background: var(--vscode-testing-iconPassed, #3fb950);
  }
  .status.idle,
  .presence.idle {
    color: var(--vscode-charts-yellow, #d7a700);
  }
  .status.idle {
    background: var(--vscode-charts-yellow, #d7a700);
  }
  .status.off,
  .presence.off {
    color: var(--vscode-descriptionForeground);
  }
  .status.off {
    background: var(--vscode-descriptionForeground);
  }
  .paddr {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    font-weight: 600;
  }
  .presence {
    margin-left: auto;
    font-size: 11px;
    font-weight: 600;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px 12px;
  }
  .cell {
    display: flex;
    flex-direction: column;
  }
  .cell .k {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--vscode-descriptionForeground);
  }
  .cell .v {
    font-size: 12px;
  }

  .section {
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .section-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .adv-badge {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-testing-iconPassed, #3fb950);
  }
  .vis {
    margin-left: auto;
    font-size: 11px;
  }
  .vis.public {
    color: var(--vscode-descriptionForeground);
  }
  .vis.private {
    color: var(--vscode-charts-blue, #4aa3ff);
    cursor: help;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .modules-edit {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .me-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--vscode-descriptionForeground);
  }
  .chip.toggle {
    cursor: pointer;
    border: 1px solid var(--vscode-panel-border);
    background: transparent;
    color: var(--vscode-descriptionForeground);
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .chip.toggle:hover:not(:disabled) {
    border-color: var(--vscode-focusBorder);
    color: var(--vscode-foreground);
  }
  .chip.toggle.on {
    border-color: transparent;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .chip.toggle:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .tick {
    font-size: 10px;
  }

  .apply-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .apply-row .hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-right: auto;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 4px;
  }
  .link:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .apply {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .apply:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  .apply:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .badge {
    font-size: 9px;
    padding: 0 5px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    vertical-align: middle;
  }

  .not-advertising {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px 12px;
  }
  .form-grid .cell {
    gap: 2px;
  }
  .form-grid input {
    width: 100%;
    box-sizing: border-box;
    font-size: 12px;
    padding: 3px 6px;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    border-top: 1px solid var(--vscode-panel-border);
    padding-top: 6px;
  }
  .mid {
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .ghost {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 2px;
    display: inline-flex;
    border-radius: 4px;
  }
  .ghost:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
  }
  .ghost :global(svg) {
    width: 15px;
    height: 15px;
  }
  .copy :global(svg) {
    width: 14px;
    height: 14px;
  }

  .note {
    font-size: 12px;
    padding: 10px 0;
  }
  .note.error {
    color: var(--vscode-errorForeground);
  }
  .dim {
    color: var(--vscode-descriptionForeground);
  }

  .empty {
    text-align: center;
    padding: 28px 16px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .empty p {
    margin: 0;
    font-size: 13px;
  }
  .big-icon :global(svg) {
    width: 34px;
    height: 34px;
    opacity: 0.5;
  }
</style>
