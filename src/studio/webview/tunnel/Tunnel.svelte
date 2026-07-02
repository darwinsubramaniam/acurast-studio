<script lang="ts">
  // Tunnel DNS wizard — orchestrator. Owns the local input state + the derived
  // verification verdicts, and dispatches to the three per-step views. Banner,
  // stepper and status pill are composed from shared/route components; the
  // status-pill / badge / step wording lives in the pure ./status helpers.
  import type { TunnelStateMsg, AcurastNetwork, WalletInfo, Route } from "../../types";
  import { onDestroy } from "svelte";
  import { send } from "../lib/vscode";
  import { statusPill, stepUiState } from "./status";
  import StatusPill from "../shared/StatusPill.svelte";
  import Stepper from "../shared/Stepper.svelte";
  import StepConfigure from "./StepConfigure.svelte";
  import StepRecords from "./StepRecords.svelte";
  import StepVerify from "./StepVerify.svelte";

  interface Props {
    tunnel: TunnelStateMsg | null;
    wallets: { list: WalletInfo[]; activeId: string | null };
    navigate: (r: Route) => void;
  }
  let { tunnel, wallets, navigate }: Props = $props();

  // Local, immediate input state. Seeded once from the host so its echo (which
  // normalizes the suffix and resolves the default wallet) never fights the caret.
  // The derived tunnel data (relays, record, verify) still flows reactively.
  let suffix = $state("");
  let network = $state<AcurastNetwork>("mainnet");
  let selectedWalletId = $state("");
  let seeded = $state(false);

  // Wizard step (1 Configure · 2 Records · 3 Verify), seeded from persisted state.
  let step = $state<1 | 2 | 3>(1);

  $effect(() => {
    if (tunnel && !seeded) {
      suffix = tunnel.suffix;
      network = tunnel.network;
      selectedWalletId = tunnel.selectedWalletId ?? wallets.activeId ?? "";
      if (tunnel.verify.status !== "idle") step = 3;
      else if (tunnel.suffix.trim().length > 0) step = 2;
      seeded = true;
    }
  });

  let debounce: ReturnType<typeof setTimeout> | undefined;
  function compute() {
    send("tunnel.compute", { suffix, network, walletId: selectedWalletId });
  }
  function onSuffixInput(value: string) {
    suffix = value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(compute, 250);
  }
  // Cancel any pending suffix-debounce on teardown so a stale tunnel.compute
  // can't fire after the view unmounts.
  onDestroy(() => {
    if (debounce) clearTimeout(debounce);
  });
  function setNetwork(n: AcurastNetwork) {
    network = n;
    compute();
  }
  function onWalletChange(id: string) {
    selectedWalletId = id;
    compute();
  }
  function verify() {
    send("tunnel.verify", { suffix, network, walletId: selectedWalletId });
  }
  function generate() {
    if (!hasSuffix) return;
    // Flush any pending debounce so records are requested for the entered suffix
    // immediately — otherwise step 2 can render before the host has computed them.
    if (debounce) clearTimeout(debounce);
    compute();
    step = 2;
  }
  function goVerify() {
    step = 3;
    verify();
  }
  function goStep(id: string | number) {
    const n = Number(id) as 1 | 2 | 3;
    if (n === 1) { step = 1; return; }
    if (hasSuffix) step = n;
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
  let servedAtUrl = $derived(
    active?.publicUrlExample ?? `https://<clientId>.${suffix.trim() || "<suffix>"}:8443`,
  );

  // Per-record verdicts (only meaningful once a verify has completed).
  let wildcardOk = $derived(verifyState.status === "done" && !!verifyState.wildcard?.ok);
  let txtOk = $derived(verifyState.status === "done" && rec?.verified === true);
  let verifiedCount = $derived((wildcardOk ? 1 : 0) + (txtOk ? 1 : 0));
  let bothVerified = $derived(verifyState.status === "done" && verifiedCount === 2);
  // Both wildcard A records and a TXT proof are needed before a verify can mean anything.
  let canVerify = $derived(hasSuffix && relays.length > 0 && walletOptions.length > 0);
  let wildcardResolvedIp = $derived(verifyState.wildcard?.resolvedIps?.[0] ?? "");

  let pill = $derived(
    statusPill({
      verifyStatus: verifyState.status,
      bothVerified,
      verifiedCount,
      hasSuffix,
      hasRelays: relays.length > 0,
      hasWallet: walletOptions.length > 0,
      step,
      netLabel,
    }),
  );

  const STEP_LABELS = ["Configure", "Records", "Verify"] as const;
  let stepperItems = $derived(
    STEP_LABELS.map((label, i) => ({
      id: i + 1,
      label,
      state: stepUiState(step, (i + 1) as 1 | 2 | 3, bothVerified),
      disabled: i + 1 !== 1 && !hasSuffix,
    })),
  );
</script>

<!-- Served-at banner + network pill + status -->
<div class="tn-banner">
  <div class="tn-banner-top">
    <span class="tn-banner-label">Your deployments are served at</span>
    <span class="net-pill static"><span class="dot"></span><span class="label">{network}</span></span>
  </div>
  <code class="tn-banner-url">{servedAtUrl}</code>
  <StatusPill label={pill.label} tone={pill.tone} />
</div>

<Stepper steps={stepperItems} onselect={goStep} />

{#if step === 1}
  <StepConfigure
    {suffix}
    {network}
    {active}
    {servedAtUrl}
    {onSuffixInput}
    onNetwork={setNetwork}
    onGenerate={generate}
  />
{:else if step === 2}
  <StepRecords
    {active}
    {rec}
    {relays}
    {txtRecordName}
    {walletOptions}
    activeWalletId={wallets.activeId}
    {selectedWalletId}
    {network}
    {netLabel}
    {verifyState}
    {canVerify}
    {onWalletChange}
    onNetwork={setNetwork}
    onVerify={goVerify}
    {navigate}
  />
{:else}
  <StepVerify
    {verifyState}
    {active}
    {txtRecordName}
    {suffix}
    {wildcardOk}
    {txtOk}
    {bothVerified}
    {canVerify}
    {wildcardResolvedIp}
    onVerify={verify}
    {navigate}
  />
{/if}

<style>
  .tn-banner {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 10px;
    padding: 11px 12px;
    margin: 2px 0 12px;
  }
  .tn-banner-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .tn-banner-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
  }
  .net-pill.static {
    cursor: default;
  }
  .net-pill.static:hover {
    filter: none;
  }
  .tn-banner-url {
    display: block;
    margin: 6px 0 8px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-foreground);
    word-break: break-all;
  }
</style>
