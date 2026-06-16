<script lang="ts">
  // Dot + label status chip. Tone drives the color; the caller derives the
  // label/tone (see tunnel/status.ts). Cross-route, so it lives in shared/.
  type Tone = "draft" | "pending" | "progress" | "warn" | "live" | "error";
  interface Props {
    label: string;
    tone: Tone;
  }
  let { label, tone }: Props = $props();
</script>

<span class="status-pill {tone}"><span class="status-pill-dot"></span>{label}</span>

<style>
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--vscode-input-background);
    color: var(--vscode-descriptionForeground);
  }
  .status-pill-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .status-pill.draft {
    color: var(--vscode-descriptionForeground);
  }
  .status-pill.pending,
  .status-pill.progress,
  .status-pill.warn {
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-input-background));
    color: var(--vscode-charts-yellow, #cca700);
  }
  .status-pill.live {
    background: var(--acu-accent-soft-bg);
    color: var(--acu-accent-soft-fg);
  }
  .status-pill.error {
    background: var(--vscode-inputValidation-errorBackground, var(--vscode-input-background));
    color: var(--vscode-errorForeground);
  }
</style>
