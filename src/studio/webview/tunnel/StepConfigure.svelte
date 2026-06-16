<script lang="ts">
  // Step 1 — pick network + domain suffix, preview the derived names, generate.
  import type { TunnelStateMsg, AcurastNetwork } from "../../types";
  import { ICONS } from "../lib/icons";

  interface Props {
    suffix: string;
    network: AcurastNetwork;
    active: TunnelStateMsg | null;
    servedAtUrl: string;
    onSuffixInput: (value: string) => void;
    onNetwork: (n: AcurastNetwork) => void;
    onGenerate: () => void;
  }
  let { suffix, network, active, servedAtUrl, onSuffixInput, onNetwork, onGenerate }: Props = $props();

  let hasSuffix = $derived(suffix.trim().length > 0);
</script>

<span class="tn-field-label" id="tn-network-label">Network</span>
<div class="tn-segmented" role="group" aria-labelledby="tn-network-label">
  <button class={network === "canary" ? "on" : ""} onclick={() => onNetwork("canary")}>Canary</button>
  <button class={network === "mainnet" ? "on" : ""} onclick={() => onNetwork("mainnet")}>Mainnet</button>
</div>

<label class="tn-field-label" for="tn-suffix">Your domain suffix</label>
<div class="tn-input-wrap">
  <input
    id="tn-suffix"
    type="text"
    placeholder="tunnel.example.com"
    value={suffix}
    oninput={(e) => onSuffixInput(e.currentTarget.value)}
    spellcheck="false"
    autocapitalize="off"
    autocomplete="off"
  />
  {#if hasSuffix}<span class="tn-input-check">{@html ICONS.check}</span>{/if}
</div>
<div class="tn-hint">
  We strip a leading <code>*.</code> or <code>_acu.</code> and lowercase it for you.
</div>

<div class="tn-preview">
  <div class="tn-preview-row">
    <span class="tn-preview-key">Wildcard</span>
    <code>{active?.wildcardName ?? "*.<suffix>"}</code>
  </div>
  <div class="tn-preview-row">
    <span class="tn-preview-key">Public URL</span>
    <code>{servedAtUrl}</code>
  </div>
</div>

<button class="primary-green full with-icon" onclick={onGenerate} disabled={!hasSuffix}>
  Generate DNS records {@html ICONS.arrowRight}
</button>

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
  .tn-hint code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    color: var(--vscode-foreground);
    word-break: break-all;
  }
  .tn-segmented {
    display: flex;
    gap: 3px;
    padding: 3px;
    margin-bottom: 12px;
    background: var(--vscode-input-background);
    border-radius: 8px;
  }
  .tn-segmented button {
    flex: 1;
    padding: 6px 0;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    background: transparent;
    color: var(--vscode-foreground);
  }
  .tn-segmented button:hover:not(.on) {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .tn-segmented button.on {
    background: var(--acu-green);
    color: var(--acu-on-accent);
    font-weight: 600;
  }
  .tn-input-wrap {
    position: relative;
  }
  .tn-input-wrap input {
    padding-right: 28px;
  }
  .tn-input-check {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    color: var(--acu-accent-soft-fg);
    pointer-events: none;
  }
  .tn-input-check :global(svg) {
    width: 14px;
    height: 14px;
  }
  .tn-preview {
    margin: 12px 0;
    padding: 9px 11px;
    background: var(--vscode-input-background);
    border-radius: 8px;
  }
  .tn-preview-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
  }
  .tn-preview-key {
    flex-shrink: 0;
    width: 64px;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
  }
  .tn-preview-row code {
    flex: 1;
    min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-foreground);
    word-break: break-all;
  }
</style>
