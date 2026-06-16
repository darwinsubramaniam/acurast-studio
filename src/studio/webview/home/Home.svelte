<script lang="ts">
  import type { Route, DeployState, WalletInfo, BalanceMsg } from "../../types";
  import { ICONS } from "../lib/icons";
  import { send } from "../lib/vscode";
  import { truncate } from "../lib/format";
  import Spinner from "../shared/Spinner.svelte";

  interface Props {
    ctx: {
      isAcurastProject: boolean;
      configPath: string | null;
      configRel: string | null;
      configExists: boolean;
      anyConfigExists: boolean;
    };
    wallets: {
      list: WalletInfo[];
      activeId: string | null;
      network: string;
      symbol: string;
    };
    balance?: BalanceMsg;
    deploy: DeployState | null;
    navigate: (r: Route) => void;
  }
  let {
    ctx,
    wallets,
    balance = { status: "idle" },
    deploy,
    navigate,
  }: Props = $props();

  // Hosted wallet-connect donation page (GitHub Pages, separate repo).
  const DONATE_URL = "https://darwinsubramaniam.github.io/acurast-studio-donate/";

  let activeWallet = $derived(
    wallets.list.find((w) => w.id === wallets.activeId) ?? null,
  );

  // Balance is in token units already (ACU/cACU); mirror the mock's "128.40".
  let balanceText = $derived.by(() => {
    if (balance.status === "ok" && typeof balance.value === "number") {
      return balance.value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      });
    }
    return null;
  });

  let walletSub = $derived(
    wallets.list.length
      ? `${wallets.list.length} wallet${wallets.list.length === 1 ? "" : "s"}${wallets.activeId ? " · active set" : ""}`
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
  <!-- StatusBar: brand + network target + settings shortcut -->
  <div class="studio-statusbar">
    <div class="brand">
      <span class="logo">{@html ICONS.logo}</span>
      <span class="name">Studio</span>
    </div>
    <div class="right">
      <button
        class="net-pill"
        onclick={() => send("network.openPicker")}
        title="Switch Studio network"
      >
        <span class="dot"></span>
        <span class="label">{wallets.network}</span>
      </button>
      <button
        class="gear-btn"
        onclick={() => navigate("settings")}
        title="Settings"
        aria-label="Settings"
      >
        {@html ICONS.braces}
      </button>
    </div>
  </div>
  <div class="home-divider"></div>

  <!-- Active wallet summary (or a setup prompt when none) -->
  {#if activeWallet}
    <button class="active-wallet" onclick={() => navigate("wallets")}>
      <span class="aw-avatar">{@html ICONS.logo}</span>
      <span class="aw-info">
        <span class="aw-name-row">
          <span class="aw-name">{activeWallet.name}</span>
          <span class="aw-badge">Active</span>
        </span>
        <span class="aw-addr" title={activeWallet.address}
          >{truncate(activeWallet.address, 8)}</span
        >
      </span>
      <span class="aw-balance">
        {#if balance.status === "ok" && balanceText}
          <span class="amt">
            <span class="val">{balanceText}</span>
            <span class="sym">{balance.symbol ?? wallets.symbol}</span>
          </span>
          <span class="lbl">balance</span>
        {:else if balance.status === "error"}
          <span class="err">error</span>
          <span class="lbl">balance</span>
        {:else}
          <Spinner size={14} />
        {/if}
      </span>
    </button>
  {:else}
    <button class="nav-card" onclick={() => navigate("wallets")}>
      <span class="icon">{@html ICONS.wallet}</span>
      <div class="body">
        <div class="title">No active wallet</div>
        <div class="sub">Create or import a wallet</div>
      </div>
      <span class="chev">{@html ICONS.chev}</span>
    </button>
  {/if}

  <!-- Navigation -->
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
      <span class="icon">{@html ICONS.braces}</span>
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

    <button class="nav-card" onclick={() => navigate("history")}>
      <span class="icon">{@html ICONS.history}</span>
      <div class="body">
        <div class="title">History</div>
        <div class="sub">All past deployments</div>
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

    <!-- Telemetry isn't built yet — styled placeholder, no live data. -->
    <button class="nav-card live-card" disabled>
      <span class="icon">{@html ICONS.monitoring}</span>
      <div class="body">
        <div class="title">
          Live Monitoring <span class="live-badge">Soon</span>
        </div>
        <div class="sub">Telemetry &amp; credits — coming soon</div>
      </div>
    </button>
  </div>

  {#if !ctx.anyConfigExists}
    <div
      style="margin: 0 0 12px; padding: 12px; border: 1px dashed var(--vscode-panel-border); border-radius: 10px; text-align: center; background: var(--vscode-textBlockQuote-background, rgba(0, 0, 0, 0.05));"
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

  <div class="security-note">
    {@html ICONS.shield}
    <span>Mnemonics encrypted · AES-256-GCM in VS Code SecretStorage</span>
  </div>
</div>
