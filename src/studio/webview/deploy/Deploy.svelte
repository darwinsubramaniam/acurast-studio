<script lang="ts">
  import type {
    Route,
    DeployState,
    PricingStateMsg,
    DiagnosisStateMsg,
  } from "../../types";
  import { send } from "../lib/vscode";
  import { ICONS } from "../lib/icons";
  import DiagnosisPanel from "../shared/DiagnosisPanel.svelte";
  import DiagnoseButton from "../shared/DiagnoseButton.svelte";
  import Spinner from "../shared/Spinner.svelte";
  import FiatNote from "../shared/FiatNote.svelte";
  import {
    planckToAcu,
    fmtFiat,
    fmtClock,
    fmtDuration,
    fmtTimestamp,
    fmtCountdown,
    truncate,
  } from "../lib/format";
  import { adviceVerdict, isNonPriceBlocker } from "../lib/pricing";
  import { networkLabel } from "../../../lib/network";

  interface Props {
    ctx: { isAcurastProject: boolean };
    deploy: DeployState | null;
    navigate: (r: Route) => void;
    pricing: PricingStateMsg | null;
    diagnoses: Record<string, DiagnosisStateMsg>;
    symbol: string;
    /** acurast.json deploy target network — labels the ready-state pill/CTA.
     * Optional so callers/tests can omit it. */
    projectNetwork?: string | null;
  }
  let {
    ctx,
    deploy,
    navigate,
    pricing,
    diagnoses,
    symbol,
    projectNetwork = null,
  }: Props = $props();

  // Live clock driving the per-processor start countdowns. Ticks once a second
  // while the deployed job has a schedule, and self-stops past its end.
  let now = $state(Date.now());
  $effect(() => {
    const sched = deploy?.schedule;
    if (!sched) return;
    const id = setInterval(() => {
      now = Date.now();
      if (now >= sched.endTime) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  });

  // Keep a live log box pinned to its newest line as output streams in.
  function autoscroll(node: HTMLElement) {
    const toBottom = () => {
      node.scrollTop = node.scrollHeight;
    };
    const obs = new MutationObserver(toBottom);
    obs.observe(node, { childList: true, subtree: true });
    toBottom();
    return {
      destroy() {
        obs.disconnect();
      },
    };
  }

  type Phase =
    | "no-project"
    | "ready"
    | "submitting"
    | "failed"
    | "live"
    | "deregistered";

  // One panel, six lifecycle states. Derived purely from props so the layout
  // always reflects the latest host push.
  let phase = $derived.by<Phase>(() => {
    if (!ctx.isAcurastProject) return "no-project";
    if (!deploy) return "ready";
    if (deploy.active) return "submitting";
    if (deploy.result === "error") return "failed";
    const ids = deploy.jobIds ?? [];
    if (ids.length > 0 && ids.every((j) => j.deregistered)) return "deregistered";
    return "live";
  });

  let procList = $derived(deploy?.processors?.list ?? []);
  let ackCount = $derived(procList.filter((p) => p.acknowledged).length);
  let procQueried = $derived(deploy?.processors?.status === "ok");
  // "Awaiting" = registered, queried the chain, nobody has accepted a slot yet.
  let awaiting = $derived(
    phase === "live" && procQueried && procList.length === 0,
  );

  // Network shown on the ready pill / CTA: the deploy record's network if we
  // have one, else the project (acurast.json) network. NOT the Studio target —
  // deploys follow acurast.json, so labelling the CTA with the Studio network
  // would name the wrong chain (see the "two network sources" doctrine).
  let deployNet = $derived(deploy?.network ?? projectNetwork ?? "");
  function netLabel(n: string | null | undefined): string {
    return n ? networkLabel(n) : "network";
  }

  // Ready-state cost verdict (drives the amber "Underpriced" treatment). Excludes
  // non-price blockers (modules/version/attestation/reputation) where the price
  // already meets the suggested rate — those aren't underpriced, and the cost
  // card explains them separately.
  let readyAdvice = $derived(
    pricing?.status === "ok" ? (pricing.advice ?? null) : null,
  );
  let underpriced = $derived(
    !!readyAdvice &&
      readyAdvice.status === "insufficient" &&
      readyAdvice.matchedProcessors < readyAdvice.requiredProcessors &&
      !isNonPriceBlocker(readyAdvice),
  );

  interface Pill {
    label: string;
    tone: "green" | "blue" | "amber" | "red" | "grey";
    spin?: boolean;
    icon?: string;
  }
  let pill = $derived.by<Pill>(() => {
    switch (phase) {
      case "no-project":
        return { label: "No project", tone: "grey" };
      case "ready":
        return underpriced
          ? { label: "Underpriced", tone: "amber" }
          : { label: netLabel(deployNet), tone: "green" };
      case "submitting":
        return { label: "Submitting", tone: "blue", spin: true };
      case "failed":
        return { label: "Failed", tone: "red", icon: ICONS.warning };
      case "live":
        return awaiting
          ? { label: "Awaiting", tone: "amber" }
          : { label: "Live", tone: "green" };
      case "deregistered":
        return { label: "Ended", tone: "grey" };
    }
  });

  let headTitle = $derived.by(() => {
    if (phase === "no-project") return "Deploy";
    if (phase === "ready") return "Ready to deploy";
    return deploy?.project ?? "Deployment";
  });
  let headSub = $derived.by(() => {
    switch (phase) {
      case "no-project":
        return "No project selected";
      case "ready":
        return "Review the estimate, then ship it";
      case "submitting":
        return `Submitting to ${netLabel(deployNet)}…`;
      case "failed":
        return "Deployment failed";
      case "deregistered":
        return "Deregistered on-chain";
      case "live": {
        const jobs = deploy?.jobIds?.length ?? 0;
        const j = `${jobs} job${jobs === 1 ? "" : "s"}`;
        if (awaiting) return `${j} · awaiting processors`;
        if (procQueried)
          return `${j} · ${procList.length} processor${procList.length === 1 ? "" : "s"} matched`;
        return `${j} registered`;
      }
    }
  });

  // Completed share of the deploy pipeline, for the progress bar.
  let progress = $derived.by(() => {
    const st = deploy?.stages ?? [];
    if (!st.length) return 0;
    return Math.round((st.filter((s) => s.status === "done").length / st.length) * 100);
  });

  // Inline link style for the "Project Settings" shortcuts inside the cost card.
  const LINK =
    "background:none;border:none;padding:0;font:inherit;font-size:11px;color:var(--vscode-textLink-foreground);cursor:pointer;";

  // High-level "what happens next" summary (ready state). Kept deliberately
  // coarse, but includes the post-submit matching phase so it doesn't imply the
  // job is done at submit — the live stage list shows the full pipeline.
  let steps = $derived([
    { label: "Package & sign", detail: "Bundle the script, sign with your wallet" },
    { label: "Upload to IPFS", detail: "Pin the bundle, resolve its CID" },
    { label: `Submit to ${netLabel(deployNet)}`, detail: "Register the deployment on-chain" },
    { label: "Match & acknowledge", detail: "Processors accept slots and start the job" },
  ]);
</script>

<div class="dpl">
  <div class="dpl-head">
    <div class="dpl-head-main">
      <div class="dpl-title">{headTitle}</div>
      <div class="dpl-sub">{headSub}</div>
    </div>
    <span class="dpl-pill {pill.tone}">
      {#if pill.spin}<Spinner size={9} />{:else if pill.icon}{@html pill.icon}{:else}<span class="dot"></span>{/if}
      {pill.label}
    </span>
  </div>

  {#if phase === "no-project"}
    <div class="dpl-empty">
      <div class="dpl-empty-icon">{@html ICONS.file}</div>
      <div class="dpl-empty-title">No acurast.json selected</div>
      <div class="dpl-empty-sub">
        Deploy needs a project config. Select an existing acurast.json, or
        initialize a new project.
      </div>
      <button class="primary-green dpl-cta" onclick={() => navigate("settings")}
        >Open Project Settings</button
      >
      <button class="dpl-btn" onclick={() => send("config.newProject")}
        >Initialize project</button
      >
    </div>
  {:else if phase === "ready"}
    <!-- Estimated cost -->
    <div class="dpl-card" class:amber={underpriced}>
      <div class="dpl-card-head">
        <span class="dpl-eyebrow">Estimated cost</span>
        <button
          class="dpl-ghost-btn"
          disabled={pricing?.status === "loading"}
          onclick={() => send("pricing.fetch")}
        >
          {#if pricing?.status === "loading"}<Spinner size={11} />{:else}Refresh{/if}
        </button>
      </div>

      {#if !pricing || pricing.status === "idle"}
        <div class="dpl-cost-note"><Spinner size={11} label="Loading…" /></div>
      {:else if pricing.status === "loading"}
        <div class="dpl-cost-note"><Spinner size={11} label="Fetching market data…" /></div>
      {:else if pricing.status === "error"}
        <div class="dpl-cost-note" style="color:var(--vscode-errorForeground);">{pricing.error}</div>
      {:else if pricing.status === "ok" && pricing.fees}
        {@const fees = pricing.fees}
        {@const advice = pricing.advice}
        {@const fiat = pricing.fiat && !pricing.fiat.error ? pricing.fiat : null}
        <!-- Symbol of the project (acurast.json) network the pricing was computed
             under — NOT the Studio-target `symbol` prop, which may diverge. -->
        {@const sym = pricing.symbol ?? symbol}
        <div class="dpl-cost-amount">
          <span class="dpl-cost-num">{fees.maxTotalCostCACU}</span>
          <span class="dpl-cost-unit">{sym}</span>
          {#if fiat}<span class="dpl-cost-fiat"><FiatNote value={fees.maxTotalCostCACU} kind="acu" {fiat} /></span>{/if}
        </div>
        <div class="dpl-cost-note">max total · {fees.maxCostPerExecutionCACU} {sym} / execution</div>

        {#if advice}
          {@const verdict = adviceVerdict(advice.status)}
          {@const tone = advice.status === "sufficient" ? "green" : "amber"}
          {@const nonPrice = isNonPriceBlocker(advice)}
          <div class="dpl-div"></div>
          <div class="dpl-status-row {tone}">
            {@html advice.status === "sufficient" ? ICONS.check : ICONS.warning}
            <span>{verdict.label}</span>
            <span class="rest"
              >· {advice.matchedProcessors}/{advice.requiredProcessors} processors{#if advice.suggestedPrice && advice.status !== "sufficient"} · suggest {planckToAcu(advice.suggestedPrice)} {sym}{/if}</span
            >
          </div>
          {#if nonPrice}
            <div class="dpl-cost-note" style="margin-top:8px;">
              Price already meets the suggested rate — 0 matches comes from a
              non-price requirement (processor version, modules, attestation, or
              reputation). Check <button style={LINK} onclick={() => navigate("settings")}>Project Settings</button>.
            </div>
          {:else if advice.status !== "sufficient"}
            <div class="dpl-cost-note" style="margin-top:8px;">
              Adjust price in <button style={LINK} onclick={() => navigate("settings")}>Project Settings</button>.
            </div>
          {/if}
        {:else if pricing.fallbackReason === "no-wallet"}
          <div class="dpl-cost-note" style="margin-top:8px;">Set an active wallet for live market pricing.</div>
        {:else if pricing.fallbackReason === "targeted"}
          <div class="dpl-cost-note" style="margin-top:8px;">
            Targeting whitelisted processors — market pricing skipped (it ignores your whitelist).
          </div>
        {:else if pricing.fallbackReason === "instant-match"}
          <div class="dpl-cost-note" style="margin-top:8px;">Instant-match job — static estimate only.</div>
        {/if}

        {#if pricing.fiat?.error}
          <div class="dpl-cost-note" style="margin-top:8px;">Fiat conversion unavailable: {pricing.fiat.error}</div>
        {:else if fiat}
          <div class="dpl-cost-note" style="margin-top:8px;">
            1 ACU ≈ {fmtFiat(fiat.acuPriceFiat, fiat.currencySign, fiat.currencySymbol)} · {fiat.exchangerName}
          </div>
        {/if}
      {/if}
    </div>

    <!-- What happens next -->
    <div class="dpl-card">
      <div class="dpl-eyebrow" style="margin-bottom:9px;">What happens next</div>
      {#each steps as s, i (i)}
        <div class="dpl-step">
          <span class="dpl-step-num">{i + 1}</span>
          <div class="dpl-step-body">
            <div class="dpl-step-label">{s.label}</div>
            <div class="dpl-step-detail">{s.detail}</div>
          </div>
        </div>
      {/each}
    </div>

    <button
      class="primary-green dpl-cta"
      disabled={!ctx.isAcurastProject}
      onclick={() => send("deploy.start")}
    >
      {@html ICONS.rocket} Deploy to {netLabel(deployNet)}
    </button>
    <button
      class="dpl-btn"
      disabled={!ctx.isAcurastProject}
      onclick={() => send("build.start")}>Build only</button
    >
    <div class="dpl-foot">
      {@html ICONS.shield}
      <span>Balance &amp; history follow the Studio network; deploys follow acurast.json.</span>
    </div>
  {:else if deploy}
    {@const d = deploy}

    <!-- Project header -->
    <div class="dpl-card">
      <div class="dpl-proj">
        <span class="dpl-proj-avatar">{@html ICONS.rocket}</span>
        <div class="dpl-proj-main">
          <div class="dpl-proj-name">{d.project ?? "Deployment"}</div>
          <div class="dpl-proj-meta">
            Started {fmtClock(d.startedAt)}{#if d.finishedAt}
              · {d.result === "error" ? "failed" : "registered"} {fmtClock(d.finishedAt)}{/if}
          </div>
        </div>
        {#if d.network}<span class="dpl-net">{netLabel(d.network)}</span>{/if}
      </div>
    </div>

    <!-- Stage pipeline -->
    {#if d.stages.length}
      <div class="dpl-card">
        {#each d.stages as s (s.id)}
          <div class="dpl-stage {s.status}">
            <span class="dpl-disc">
              {#if s.status === "active"}<Spinner size={12} />{/if}
            </span>
            <div class="dpl-stage-body">
              <div class="dpl-stage-label">{s.label}</div>
              {#if s.detail}<div class="dpl-stage-detail">{s.detail}</div>{/if}
              {#if s.logs && s.logs.length}
                {#if s.status === "active" || s.status === "error"}
                  <div class="dpl-logbox" use:autoscroll>
                    {#each s.logs as ln, i (i)}
                      <div class="logline log-{ln.level}">{ln.text || " "}</div>
                    {/each}
                  </div>
                {:else}
                  <details class="logdetails">
                    <summary
                      >{s.logs.length} log line{s.logs.length === 1 ? "" : "s"}</summary
                    >
                    <div class="dpl-logbox">
                      {#each s.logs as ln, i (i)}
                        <div class="logline log-{ln.level}">{ln.text || " "}</div>
                      {/each}
                    </div>
                  </details>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      </div>
      {#if phase === "submitting" || phase === "failed"}
        <div class="dpl-progress" class:error={phase === "failed"}>
          <div class="dpl-progress-fill" style="width:{progress}%"></div>
        </div>
      {/if}
    {/if}

    {#if phase === "failed" && d.errorMessage}
      <div class="dpl-errmsg">{d.errorMessage}</div>
    {/if}

    <!-- Deployment ID card(s) -->
    {#each d.jobIds as j (j.origin + ":" + j.localId)}
      {@const dkey = `${j.origin}:${j.localId}`}
      <div class="dpl-card" class:ended={j.deregistered}>
        <div class="dpl-card-head">
          <span class="dpl-eyebrow">Deployment ID</span>
          {#if j.deregistered}<span class="dpl-dereg-badge">Deregistered</span>{/if}
        </div>
        <div class="dpl-id-num">
          <span class="num">{j.localId}</span>
          <span class="origin" title={j.origin}>· origin {truncate(j.origin, 8)}</span>
        </div>
        <div class="dpl-id-actions">
          <button class="dpl-ghost-btn" onclick={() => send("deploy.copy", { text: String(j.localId) })}>Copy ID</button>
          <button class="dpl-ghost-btn" onclick={() => send("deploy.copy", { text: j.origin })}>Copy origin</button>
          {#if !j.deregistered}
            <button
              class="dpl-ghost-btn danger"
              disabled={j.deregistering}
              onclick={() => send("deploy.deregister", { origin: j.origin, localId: j.localId })}
            >
              {#if j.deregistering}<Spinner size={10} label="Deregistering…" />{:else}Deregister{/if}
            </button>
          {/if}
          {#if d.network}
            <DiagnoseButton
              state={diagnoses[dkey]}
              idleLabel="Why not matched?"
              onclick={() =>
                send("history.diagnose", {
                  origin: j.origin,
                  localId: j.localId,
                  network: d.network,
                })}
            />
          {/if}
        </div>
        {#if d.network}
          <DiagnosisPanel state={diagnoses[dkey]} />
        {/if}
        {#if j.deregisterTxHash}<div class="dpl-dereg-tx" title={j.deregisterTxHash}>tx {truncate(j.deregisterTxHash, 10)}</div>{/if}
        {#if j.deregisterError}<div class="dpl-dereg-err">{j.deregisterError}</div>{/if}
      </div>
    {/each}

    <!-- DevTools -->
    {#if d.devtoolsEnabled}
      <div class="dpl-card">
        <div class="dpl-card-head">
          <span class="dpl-eyebrow">DevTools</span>
          <button class="dpl-ghost-btn" disabled={!!d.devtoolsLoading} onclick={() => send("devtools.refreshKey")}>
            {#if d.devtoolsLoading}<Spinner size={11} />{:else}{d.devtoolsUrl ? "Refresh key" : "Get URL"}{/if}
          </button>
        </div>
        {#if d.devtoolsUrl}
          <div class="dpl-url-row">
            <span class="dpl-url" title={d.devtoolsUrl}>{d.devtoolsUrl}</span>
            <button class="dpl-ghost-btn" onclick={() => send("deploy.copy", { text: d.devtoolsUrl! })}>Copy</button>
            <button class="dpl-ghost-btn" onclick={() => send("devtools.openUrl", { url: d.devtoolsUrl! })}>Open</button>
          </div>
          <div class="dpl-hint">View key is time-limited. Click "Refresh key" if it expires.</div>
        {:else if !d.devtoolsLoading}
          <div class="dpl-hint">Click "Get URL" to generate a DevTools view key.</div>
        {/if}
      </div>
    {/if}

    {#if d.jobIds.length}
      {@const proc = d.processors ?? { status: "idle" }}
      {@const events = d.chainEvents ?? []}
      {@const watching = !!d.watching}

      <!-- Processors -->
      <div class="dpl-card">
        <div class="dpl-card-head">
          <span class="dpl-eyebrow">Processors</span>
          {#if proc.status === "ok"}
            {#if phase === "deregistered"}
              <span class="dpl-count grey">released</span>
            {:else if procList.length}
              <span class="dpl-count {ackCount === procList.length ? 'green' : 'amber'}"
                >{ackCount} / {procList.length} acknowledged</span
              >
            {:else}
              <span class="dpl-count amber">0 matched</span>
            {/if}
          {/if}
          <button class="dpl-ghost-btn" disabled={proc.status === "loading"} onclick={() => send("deploy.queryProcessors")}>
            {#if proc.status === "loading"}<Spinner size={11} />{:else}Refresh{/if}
          </button>
        </div>

        {#if d.schedule?.startTime}
          <div class="proc-window" title="Job schedule window (from acurast.storedJobRegistration)">
            Window {fmtClock(d.schedule.startTime)} → {fmtClock(d.schedule.endTime)}{#if d.schedule.maxStartDelay}
              · max delay {fmtDuration(d.schedule.maxStartDelay)}{/if}
          </div>
        {/if}

        {#if proc.status === "idle"}
          <div class="dpl-card-note">Click "Refresh" to query assigned processors.</div>
        {:else if proc.status === "loading"}
          <div class="dpl-card-note"><Spinner size={11} label="Querying chain…" /></div>
        {:else if proc.status === "error"}
          <div class="dpl-card-note" style="color:var(--vscode-errorForeground);">{proc.message || "Query failed"}</div>
        {:else if proc.status === "ok"}
          {#if phase === "deregistered"}
            <div class="dpl-card-note">Processors released — the job is no longer scheduled.</div>
          {:else if !procList.length}
            <div class="dpl-card-note">
              No processors have accepted yet — your price or device requirements may be filtering them out.
            </div>
          {:else}
            {#each procList as p (p.address)}
              <div class="dpl-proc">
                <div class="dpl-proc-top">
                  <span class="dot {p.acknowledged ? 'ack' : 'noack'}"></span>
                  <span class="dpl-proc-addr" title={p.address}>{truncate(p.address, 8)}</span>
                  {#if p.acknowledged}<span class="dpl-proc-ack">acknowledged</span>{:else}<span class="dpl-proc-pending">pending ack</span>{/if}
                </div>
                <div class="dpl-proc-meta">
                  {#if p.slot != null}slot <b>{p.slot}</b>{/if}
                  {#if p.feePerExecution != null} · fee <b>{p.feePerExecution}</b>{/if}
                  {#if p.slaTotal != null} · SLA <b>{p.slaMet ?? "0"}/{p.slaTotal}</b>{/if}
                  {#if p.startDelay != null} · delay <b title={`${p.startDelay}ms`}>{fmtDuration(p.startDelay)}</b>{/if}
                </div>
                {#if d.schedule?.startTime}
                  {@const actualStart = d.schedule.startTime + (p.startDelay ?? 0)}
                  <div class="proc-start">
                    starts <b title={fmtTimestamp(actualStart)}>{fmtClock(actualStart)}</b>
                    · <span style="color:var(--vscode-charts-blue, var(--vscode-textLink-foreground));"
                      >{now >= d.schedule.endTime ? "ended" : fmtCountdown(actualStart - now)}</span
                    >
                  </div>
                {/if}
                {#if p.pubKeys?.length}
                  <div class="proc-keys">
                    <div class="proc-keys-label">Public keys (for topup)</div>
                    {#each p.pubKeys as k (k.curve + ":" + k.key)}
                      <div class="pk-row">
                        <span class="pk-curve">{k.curve}</span>
                        <span class="pk-key" title={k.key}>{k.key}</span>
                        <button class="pk-copy" onclick={() => send("deploy.copy", { text: k.key })}>Copy</button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        {/if}
      </div>

      <!-- Lifecycle / chain events -->
      <div class="dpl-card">
        <div class="dpl-card-head">
          <span class="dpl-live-dot {watching ? '' : 'off'}" title={watching ? "Live" : "Not watching"}></span>
          <span class="dpl-eyebrow">Lifecycle · {watching ? "live" : events.length ? "stopped" : "idle"}</span>
        </div>
        {#if !events.length}
          <div class="dpl-card-note">
            {watching ? "Waiting for on-chain events…" : "No on-chain events captured yet."}
          </div>
        {:else}
          {#each events.slice().reverse() as e, i (i)}
            {@const label = e.label || e.method}
            {@const showRaw = e.label && e.label !== e.method}
            <div class="dpl-lc-row {e.kind}">
              <span class="dpl-lc-ts">{fmtClock(e.ts)}</span>
              <div class="dpl-lc-body">
                <span class="dpl-lc-label">{label}</span>
                {#if showRaw}<span class="dpl-lc-raw">({e.section}.{e.method})</span>{:else}<span class="dpl-lc-raw">· {e.section}</span>{/if}
                {#if e.jobLocalId != null}<span class="dpl-lc-raw">· job {e.jobLocalId}</span>{/if}
                {#if e.summary}<div class="dpl-lc-payload">{e.summary}</div>{/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Actions -->
    {#if !d.active}
      <div class="dpl-actions">
        <button class="primary-green dpl-cta" disabled={!ctx.isAcurastProject} onclick={() => send("deploy.start")}>
          {@html ICONS.rocket} {phase === "failed" ? "Retry deploy" : "Deploy again"}
        </button>
        <button class="dpl-btn" disabled={!ctx.isAcurastProject} onclick={() => send("build.start")}>Build only</button>
      </div>
    {/if}
    <button class="dpl-btn" onclick={() => send("deploy.openOutput")}>Open output</button>
  {/if}
</div>
