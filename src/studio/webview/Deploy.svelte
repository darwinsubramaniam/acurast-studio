<script lang="ts">
  import type { Route, DeployState, PricingStateMsg } from "../types";
  import { send } from "./lib/vscode";
  import { ICONS } from "./lib/icons";
  import {
    planckToAcu,
    planckToFiat,
    acuToFiat,
    fmtFiat,
    fmtClock,
    fmtMs,
  } from "./lib/format";

  interface Props {
    ctx: { isAcurastProject: boolean };
    deploy: DeployState | null;
    navigate: (r: Route) => void;
    pricing: PricingStateMsg | null;
  }
  let { ctx, deploy, pricing }: Props = $props();

  const satoshiToACU = planckToAcu;
  const satoshiToFiat = planckToFiat;
  const fmtTime = fmtClock;

  function statusClass(d: DeployState): string {
    if (d.active) return "running";
    if (d.result === "ok") return "ok";
    if (d.result === "error") return "err";
    return "idle";
  }

  function statusLabel(d: DeployState): string {
    if (d.active) return "Running";
    if (d.result === "ok") return "Success";
    if (d.result === "error") return "Failed";
    return "Idle";
  }
</script>

{#if !deploy}
  <div class="empty" style="text-align:center;">
    <div style="margin: 12px 0; opacity:0.7;">{@html ICONS.deployments}</div>
    <p>No active deployment.</p>
    {#if ctx.isAcurastProject}
      <button class="full" onclick={() => send("deploy.start")}
        >Deploy now</button
      >
    {:else}
      <p style="font-size:11px;">
        Select an <code>acurast.json</code> from Project Settings to enable deploy.
      </p>
    {/if}
  </div>

  {#if ctx.isAcurastProject}
    <div class="pricing-box" style="margin-top:8px;">
      <div class="pricing-box-header">
        <span class="pricing-box-title">Cost Estimate</span>
        <button
          class="secondary"
          style="font-size:10px;padding:2px 8px;"
          disabled={pricing?.status === "loading"}
          onclick={() => send("pricing.fetch")}
        >
          {pricing?.status === "loading" ? "Checking…" : "⟳"}
        </button>
      </div>

      {#if !pricing || pricing.status === "idle"}
        <div class="pricing-muted">Loading…</div>
      {:else if pricing.status === "loading"}
        <div class="pricing-muted">Fetching market data…</div>
      {:else if pricing.status === "error"}
        <div class="pricing-error-note">{pricing.error}</div>
      {:else if pricing.status === "ok" && pricing.fees}
        {@const fees = pricing.fees}
        {@const advice = pricing.advice}
        {@const fiat =
          pricing.fiat && !pricing.fiat.error ? pricing.fiat : null}
        {#if advice}
          {@const nonPriceBlocker =
            advice.status === "insufficient" &&
            advice.suggestedPrice != null &&
            parseFloat(advice.currentPrice) >= parseFloat(advice.suggestedPrice)}
          <div
            class="pricing-status-row pricing-{advice.status}"
            style="margin-bottom:6px;"
          >
            <span>
              {advice.status === "sufficient"
                ? "✓"
                : advice.status === "overpaying"
                  ? "⚠"
                  : "✗"}
              {advice.status === "sufficient"
                ? "Sufficient"
                : advice.status === "overpaying"
                  ? "Overpaying"
                  : "Insufficient"}
            </span>
            <span class="pricing-match"
              >{advice.matchedProcessors}/{advice.requiredProcessors} processors</span
            >
          </div>
          <div class="pricing-rows">
            <span class="pricing-label">Your price</span>
            <span class="pricing-value">
              {satoshiToACU(advice.currentPrice)} / exec
              {#if fiat}{@const f = satoshiToFiat(
                  advice.currentPrice,
                  fiat.acuPriceFiat,
                )}{#if f != null}<span class="pricing-fiat"
                    >(~{fmtFiat(
                      f,
                      fiat.currencySign,
                      fiat.currencySymbol,
                    )})</span
                  >{/if}{/if}
            </span>
            {#if advice.suggestedPrice && advice.status !== "sufficient"}
              <span class="pricing-label">Suggested</span>
              <span class="pricing-value">
                {satoshiToACU(advice.suggestedPrice)} / exec
                {#if fiat}{@const f = satoshiToFiat(
                    advice.suggestedPrice,
                    fiat.acuPriceFiat,
                  )}{#if f != null}<span class="pricing-fiat"
                      >(~{fmtFiat(
                        f,
                        fiat.currencySign,
                        fiat.currencySymbol,
                      )})</span
                    >{/if}{/if}
              </span>
            {/if}
            <span class="pricing-label">Total max</span>
            <span class="pricing-value">
              {fees.maxTotalCostCACU}
              {#if fiat}{@const f = acuToFiat(
                  fees.maxTotalCostCACU,
                  fiat.acuPriceFiat,
                )}{#if f != null}<span class="pricing-fiat"
                    >(~{fmtFiat(
                      f,
                      fiat.currencySign,
                      fiat.currencySymbol,
                    )})</span
                  >{/if}{/if}
            </span>
          </div>
          {#if nonPriceBlocker}
            <div class="pricing-muted" style="margin-top:4px;">
              Price already meets the suggested rate — 0 matches is from a
              non-price requirement (processor version, modules, attestation, or
              reputation). Check requirements in <button
                style="background:none;border:none;padding:0;color:var(--vscode-textLink-foreground);cursor:pointer;font:inherit;font-size:10px;"
                onclick={() => send("navigate", { route: "settings" })}
                >Project Settings</button
              >.
            </div>
          {:else if advice.status !== "sufficient"}
            <div class="pricing-muted" style="margin-top:4px;">
              Adjust price in <button
                style="background:none;border:none;padding:0;color:var(--vscode-textLink-foreground);cursor:pointer;font:inherit;font-size:10px;"
                onclick={() => send("navigate", { route: "settings" })}
                >Project Settings</button
              >.
            </div>
          {/if}
        {:else}
          <div class="pricing-rows">
            <span class="pricing-label">Max / exec</span>
            <span class="pricing-value">
              {fees.maxCostPerExecutionCACU}
              {#if fiat}{@const f = acuToFiat(
                  fees.maxCostPerExecutionCACU,
                  fiat.acuPriceFiat,
                )}{#if f != null}<span class="pricing-fiat"
                    >(~{fmtFiat(
                      f,
                      fiat.currencySign,
                      fiat.currencySymbol,
                    )})</span
                  >{/if}{/if}
            </span>
            <span class="pricing-label">Total max</span>
            <span class="pricing-value">
              {fees.maxTotalCostCACU}
              {#if fiat}{@const f = acuToFiat(
                  fees.maxTotalCostCACU,
                  fiat.acuPriceFiat,
                )}{#if f != null}<span class="pricing-fiat"
                    >(~{fmtFiat(
                      f,
                      fiat.currencySign,
                      fiat.currencySymbol,
                    )})</span
                  >{/if}{/if}
            </span>
          </div>
          {#if pricing.fallbackReason === "no-wallet"}
            <div class="pricing-muted" style="margin-top:4px;">
              Set an active wallet for live market pricing.
            </div>
          {:else if pricing.fallbackReason === "targeted"}
            <div class="pricing-muted" style="margin-top:4px;">
              Targeting whitelisted processors — market pricing skipped (it
              ignores your whitelist).
            </div>
          {:else if pricing.fallbackReason === "instant-match"}
            <div class="pricing-muted" style="margin-top:4px;">
              Instant-match job — static estimate only.
            </div>
          {/if}
        {/if}
        {#if pricing.fiat?.error}
          <div class="pricing-muted" style="margin-top:4px;">
            Fiat conversion unavailable: {pricing.fiat.error}
          </div>
        {:else if fiat}
          <div class="pricing-muted" style="margin-top:4px;">
            1 ACU ≈ {fmtFiat(
              fiat.acuPriceFiat,
              fiat.currencySign,
              fiat.currencySymbol,
            )} · {fiat.exchangerName}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
{:else}
  {@const d = deploy}

  <div class="dep-head">
    <div class="proj">
      <div class="proj-name">
        {d.project ?? "Unknown project"}{d.network ? ` · ${d.network}` : ""}
      </div>
      <div
        class="proj-meta"
        title="Times for the deploy flow. The job continues executing on processors after this."
      >
        Started {fmtTime(d.startedAt)}
        {#if d.finishedAt}
          · {d.result === "error" ? "failed" : "registered"}
          {fmtTime(d.finishedAt)}{/if}
      </div>
    </div>
    <span class="dep-status {statusClass(d)}">{statusLabel(d)}</span>
  </div>

  {#if d.errorMessage}
    <div class="dep-error">{d.errorMessage}</div>
  {/if}

  <!-- Job ID cards -->
  {#each d.jobIds as j (j.origin + ":" + j.localId)}
    <div class="dep-id {j.deregistered ? 'deregistered' : ''}">
      <div class="label">
        Deployment ID
        {#if j.deregistered}<span class="dereg-badge">Deregistered</span>{/if}
      </div>
      <div class="id-row">
        <div class="id-num">{j.localId}</div>
        <div class="id-origin" title={j.origin}>{j.origin}</div>
      </div>
      <div class="id-actions">
        <button onclick={() => send("deploy.copy", { text: String(j.localId) })}
          >Copy ID</button
        >
        <button onclick={() => send("deploy.copy", { text: j.origin })}
          >Copy origin</button
        >
        {#if !j.deregistered}
          <button
            class="danger"
            disabled={j.deregistering}
            onclick={() =>
              send("deploy.deregister", {
                origin: j.origin,
                localId: j.localId,
              })}
          >
            {j.deregistering ? "Deregistering…" : "Deregister"}
          </button>
        {/if}
      </div>
      {#if j.deregisterTxHash}<div class="dereg-tx" title={j.deregisterTxHash}>
          tx {j.deregisterTxHash}
        </div>{/if}
      {#if j.deregisterError}<div class="dereg-error">
          {j.deregisterError}
        </div>{/if}
    </div>
  {/each}

  <!-- Stage list -->
  <ul class="stages">
    {#each d.stages as s (s.id)}
      <li class="stage {s.status}">
        <span class="dot"></span>
        <div class="body">
          <div class="label">{s.label}</div>
          {#if s.detail}<div class="detail">{s.detail}</div>{/if}
        </div>
      </li>
    {/each}
  </ul>

  <!-- DevTools block -->
  {#if d.devtoolsEnabled}
    <div class="devtools-section">
      <div class="devtools-head">
        <h3>DevTools</h3>
        <button
          disabled={!!d.devtoolsLoading}
          onclick={() => send("devtools.refreshKey")}
        >
          {d.devtoolsLoading
            ? "Fetching…"
            : d.devtoolsUrl
              ? "⟳ Refresh key"
              : "Get URL"}
        </button>
      </div>
      {#if d.devtoolsUrl}
        <div class="devtools-url-row">
          <span class="devtools-url" title={d.devtoolsUrl}>{d.devtoolsUrl}</span
          >
          <button
            class="pk-copy"
            onclick={() => send("deploy.copy", { text: d.devtoolsUrl! })}
            >Copy</button
          >
          <button
            onclick={() => send("devtools.openUrl", { url: d.devtoolsUrl! })}
            >Open</button
          >
        </div>
        <div class="devtools-hint">
          View key is time-limited. Click "⟳ Refresh key" if it expires.
        </div>
      {:else if !d.devtoolsLoading}
        <div class="devtools-hint">
          Click "Get URL" to generate a DevTools view key.
        </div>
      {/if}
    </div>
  {/if}

  <!-- Processors block -->
  {#if d.jobIds.length}
    {@const proc = d.processors ?? { status: "idle" }}
    <div class="proc-section">
      <div class="proc-head">
        <h3>
          Processors{proc.fetchedAt ? ` · ${fmtTime(proc.fetchedAt)}` : ""}
        </h3>
        <button
          disabled={proc.status === "loading"}
          onclick={() => send("deploy.queryProcessors")}>Refresh</button
        >
      </div>
      {#if proc.status === "idle"}
        <div class="proc-empty">
          Click "Refresh" to query assigned processors.
        </div>
      {:else if proc.status === "loading"}
        <div class="proc-loading">Querying chain…</div>
      {:else if proc.status === "error"}
        <div class="proc-error">{proc.message || "Query failed"}</div>
      {:else if proc.status === "ok"}
        {#if !proc.list?.length}
          <div class="proc-empty">No processors assigned yet.</div>
        {:else}
          {#each proc.list as p (p.address)}
            <div class="proc-card">
              <div class="proc-addr" title={p.address}>{p.address}</div>
              <div class="proc-meta">
                {#if p.acknowledged}
                  <span class="proc-ack">✓ acknowledged</span>
                {:else}
                  <span class="proc-noack">pending ack</span>
                {/if}
                {#if p.slot != null}<span>slot <b>{p.slot}</b></span>{/if}
                {#if p.feePerExecution != null}<span
                    >fee <b>{p.feePerExecution}</b></span
                  >{/if}
                {#if p.slaTotal != null}<span
                    >SLA <b>{p.slaMet ?? "0"}/{p.slaTotal}</b></span
                  >{/if}
                {#if p.startDelay != null}<span
                    >delay <b title={`${p.startDelay}ms`}>{fmtMs(p.startDelay)}</b></span
                  >{/if}
              </div>
              {#if p.pubKeys?.length}
                <div class="proc-keys">
                  <div class="proc-keys-label">Public keys (for topup)</div>
                  {#each p.pubKeys as k (k.curve + ":" + k.key)}
                    <div class="pk-row">
                      <span class="pk-curve">{k.curve}</span>
                      <span class="pk-key" title={k.key}>{k.key}</span>
                      <button
                        class="pk-copy"
                        onclick={() => send("deploy.copy", { text: k.key })}
                        >Copy</button
                      >
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
    {@const events = d.chainEvents ?? []}
    {@const watching = !!d.watching}
    <div class="lc-section">
      <div class="lc-head">
        <span
          class="lc-dot {watching ? '' : 'off'}"
          title={watching ? "Live" : "Not watching"}
        ></span>
        <h3>
          Lifecycle · {watching ? "Live" : events.length ? "Stopped" : "Idle"} ·
          {events.length}
        </h3>
      </div>
      {#if !events.length}
        <div class="lc-empty">
          {watching
            ? "Waiting for on-chain events…"
            : "No on-chain events captured yet."}
        </div>
      {:else}
        <ul class="lc-list">
          {#each events.slice().reverse() as e}
            {@const label = e.label || e.method}
            {@const showRaw = e.label && e.label !== e.method}
            <li class="lc-row {e.kind}">
              <span class="ts">{fmtTime(e.ts)}</span>
              <div style="flex:1; min-width:0;">
                <span class="meth">{label}</span>
                {#if showRaw}
                  <span class="sec" title="raw event"
                    >({e.section}.{e.method})</span
                  >
                {:else}
                  <span class="sec"> · {e.section}</span>
                {/if}
                {#if e.jobLocalId != null}<span class="sec">
                    · job {e.jobLocalId}</span
                  >{/if}
                {#if e.summary}<div class="payload">{e.summary}</div>{/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <!-- Footer -->
  <div class="toolbar" style="margin-top:10px;">
    {#if !d.active}
      <button
        disabled={!ctx.isAcurastProject}
        onclick={() => send("deploy.start")}
      >
        {d.result === "error" ? "Retry deploy" : "Deploy again"}
      </button>
    {/if}
    <button class="secondary" onclick={() => send("deploy.openOutput")}
      >Open output</button
    >
  </div>
{/if}
