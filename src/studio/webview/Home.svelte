<script lang="ts">
  import type { Route, DeployState, WalletInfo } from "../types";
  import { ICONS } from "./lib/icons";
  import { send } from "./lib/vscode";

  interface Props {
    ctx: {
      isAcurastProject: boolean;
      configPath: string | null;
      configRel: string | null;
      configExists: boolean;
      anyConfigExists: boolean;
    };
    wallets: { list: WalletInfo[]; activeId: string | null };
    deploy: DeployState | null;
    navigate: (r: Route) => void;
  }
  let { ctx, wallets, deploy, navigate }: Props = $props();

  // Hosted wallet-connect donation page (GitHub Pages, separate repo).
  const DONATE_URL = "https://darwinsubramaniam.github.io/acurast-studio-donate/";

  let walletSub = $derived(
    wallets.list.length
      ? `${wallets.list.length} wallet${wallets.list.length === 1 ? "" : "s"}${wallets.activeId ? " • active set" : ""}`
      : "Create or import to begin",
  );

  let processorSub = $derived(
    wallets.list.length
      ? "Devices paired to your wallets"
      : "Add a wallet to check",
  );

  let isProjectSettingsDisabled = $derived.by(() => {
    if (!ctx.isAcurastProject) return true;
    if (!ctx.configExists && !ctx.anyConfigExists) return true;
    return false;
  });

  let projectWarning = $derived(!ctx.configExists && ctx.isAcurastProject);

  let projectSub = $derived.by(() => {
    if (!ctx.isAcurastProject) {
      if (!ctx.anyConfigExists) {
        return "Create it using the command acurast:init project";
      }
      return "No acurast.json selected";
    }
    if (!ctx.configExists) {
      if (ctx.anyConfigExists) {
        return "Targeted acurast.json is missing";
      } else {
        return "Targeted acurast.json is missing. Create it using the command acurast:init project";
      }
    }
    return ctx.configRel || "acurast.json";
  });

  let deploySub = $derived.by(() => {
    const d = deploy;
    if (!d) return "No deployments yet";
    if (d.active) {
      const stage = d.stages?.find((s) => s.status === "active");
      return stage ? `Running · ${stage.label}` : "Running";
    }
    if (d.result === "ok")
      return "Last deploy succeeded" + (d.project ? ` · ${d.project}` : "");
    if (d.result === "error") return "Last deploy failed";
    return "Idle";
  });
</script>

<div class="home-view">
<div class="hero">
  <div>{@html ICONS.home}</div>
  <h1>Acurast Studio</h1>
  <p>Wallets, project config, and deployments in one place.</p>
</div>

<div class="nav-grid">
  <button class="nav-card" onclick={() => navigate("wallets")}>
    <span class="icon">{@html ICONS.wallet}</span>
    <div class="body">
      <div class="title">Wallets</div>
      <div class="sub">{walletSub}</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button
    class="nav-card"
    onclick={() => navigate("settings")}
    disabled={isProjectSettingsDisabled}
  >
    <span class="icon">{@html ICONS.settings}</span>
    <div class="body">
      <div class="title">Project Settings</div>
      <div
        class="sub"
        style={projectWarning
          ? "color: var(--vscode-errorForeground); font-weight: 500;"
          : ""}
      >
        {projectSub}
      </div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button class="nav-card" onclick={() => navigate("deploy")}>
    <span class="icon">{@html ICONS.deployments}</span>
    <div class="body">
      <div class="title">Deployments</div>
      <div class="sub">{deploySub}</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button class="nav-card" onclick={() => navigate("processors")}>
    <span class="icon">{@html ICONS.processor}</span>
    <div class="body">
      <div class="title">Processors</div>
      <div class="sub">{processorSub}</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button class="nav-card" onclick={() => navigate("tunnel")}>
    <span class="icon">{@html ICONS.globe}</span>
    <div class="body">
      <div class="title">Tunnel DNS</div>
      <div class="sub">Configure deployment DNS records</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button class="nav-card" onclick={() => navigate("history")}>
    <span class="icon">{@html ICONS.history}</span>
    <div class="body">
      <div class="title">History</div>
      <div class="sub">All past deployments</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button class="nav-card" disabled>
    <span class="icon">{@html ICONS.monitoring}</span>
    <div class="body">
      <div class="title">Live Monitoring <span class="badge">Soon</span></div>
      <div class="sub">Coming soon</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>
</div>

{#if !ctx.anyConfigExists}
  <div
    style="margin: 12px 0 6px; padding: 12px; border: 1px dashed var(--vscode-panel-border); border-radius: 4px; text-align: center; background: var(--vscode-textBlockQuote-background, rgba(0, 0, 0, 0.05));"
  >
    <div
      style="font-size: 11px; margin-bottom: 8px; color: var(--vscode-descriptionForeground);"
    >
      No <code>acurast.json</code> found in this workspace.
    </div>
    <button
      class="full"
      style="font-size: 12px; font-weight: 600;"
      onclick={() => send("config.newProject")}
    >
      Initialize Acurast Project
    </button>
  </div>
{/if}

<div class="donate-card">
  <div class="donate-head">
    <span class="donate-icon">{@html ICONS.heart}</span>
    <div>
      <div class="donate-title">Support development</div>
    </div>
  </div>
  <button
    class="donate-link"
    onclick={() => send("openExternal", { url: DONATE_URL })}
  >
    <span class="donate-link-icon">{@html ICONS.globe}</span>
    Open donation page
  </button>
</div>
</div>
