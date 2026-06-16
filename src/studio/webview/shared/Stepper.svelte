<script lang="ts">
  // Numbered wizard stepper. Presentational: the caller passes each step's
  // precomputed UI state and gets a callback on select. Cross-route, so shared/.
  import { ICONS } from "../lib/icons";

  type StepUiState = "done" | "active" | "todo";
  interface StepItem {
    id: string | number;
    label: string;
    state: StepUiState;
    disabled?: boolean;
  }
  interface Props {
    steps: StepItem[];
    onselect: (id: string | number) => void;
  }
  let { steps, onselect }: Props = $props();
</script>

<div class="stepper">
  {#each steps as s, i (s.id)}
    <button class="step {s.state}" onclick={() => onselect(s.id)} disabled={s.disabled}>
      <span class="step-num">
        {#if s.state === "done"}<span class="step-check">{@html ICONS.check}</span>{:else}{i + 1}{/if}
      </span>
      <span class="step-label">{s.label}</span>
    </button>
  {/each}
</div>

<style>
  .stepper {
    display: flex;
    gap: 6px;
    margin: 0 0 14px;
  }
  .step {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 4px;
    border-radius: 8px;
    font-size: 11.5px;
    font-weight: 500;
    background: var(--vscode-input-background);
    color: var(--vscode-descriptionForeground);
    border: 1px solid transparent;
  }
  .step:hover:not(:disabled) {
    border-color: var(--vscode-focusBorder);
  }
  .step:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .step-num {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9.5px;
    font-weight: 700;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .step.active {
    background: var(--acu-green);
    color: var(--acu-on-accent);
    font-weight: 600;
  }
  .step.active .step-num {
    background: rgba(0, 0, 0, 0.22);
    color: var(--acu-on-accent);
  }
  .step.done {
    background: var(--acu-accent-soft-bg);
    color: var(--acu-accent-soft-fg);
  }
  .step.done .step-num {
    background: transparent;
  }
  .step-check {
    display: inline-flex;
  }
  .step-check :global(svg) {
    width: 13px;
    height: 13px;
  }
</style>
