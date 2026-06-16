<script lang="ts">
  import type { Route } from "../../types";
  import { send } from "../lib/vscode";
  import { networkLabel as cap, isNetworkMismatch } from "../../../lib/network";

  interface Props {
    projectNetwork: string | null;
    targetNetwork: string;
    /** Where the banner is shown — Settings already has the network field, so it
     * hides the "Edit project network" shortcut. */
    context: "deploy" | "settings";
    navigate: (route: Route) => void;
  }
  let { projectNetwork, targetNetwork, context, navigate }: Props = $props();

  let mismatch = $derived(isNetworkMismatch(projectNetwork, targetNetwork));
</script>

{#if mismatch && projectNetwork}
  <div class="mismatch" role="alert">
    <span class="ico">⚠️</span>
    <div class="body">
      <div class="msg">
        <strong>acurast.json deploys to {cap(projectNetwork)}</strong>, but Acurast
        Studio is targeting <strong>{cap(targetNetwork)}</strong>. Balance,
        processors and history follow the Studio target; deploys follow
        acurast.json.
      </div>
      <div class="actions">
        <button
          class="primary"
          onclick={() => send("network.setTarget", { network: projectNetwork })}
        >
          Use {cap(projectNetwork)} in Studio
        </button>
        {#if context === "deploy"}
          <button class="ghost" onclick={() => navigate("settings")}>
            Edit project network
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .mismatch {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid var(--vscode-inputValidation-warningBorder, #c8a000);
    background: var(--vscode-inputValidation-warningBackground, rgba(200, 160, 0, 0.1));
    color: var(--vscode-foreground);
    margin-bottom: 12px;
  }
  .ico {
    flex: none;
    line-height: 1.4;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .msg {
    font-size: 12px;
    line-height: 1.4;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  button {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .ghost {
    background: transparent;
    border-color: var(--vscode-panel-border);
    color: var(--vscode-foreground);
  }
  .ghost:hover {
    border-color: var(--vscode-focusBorder);
  }
</style>
