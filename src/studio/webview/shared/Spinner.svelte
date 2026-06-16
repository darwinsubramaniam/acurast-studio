<script lang="ts">
  // Circular progress indicator for any in-flight network request/response.
  // Inherits the surrounding text color (currentColor) so it reads correctly
  // inside buttons, muted notes, and badges alike. Pass `label` to render the
  // spinner inline with text (e.g. button states like "Diagnosing…").
  interface Props {
    /** Diameter in px. */
    size?: number;
    /** Optional text rendered next to the spinner. */
    label?: string;
  }
  let { size = 12, label }: Props = $props();
</script>

{#if label}
  <span class="sp-inline">
    <span class="spinner" style="--sp:{size}px"></span><span>{label}</span>
  </span>
{:else}
  <span class="spinner" style="--sp:{size}px"></span>
{/if}

<style>
  .sp-inline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    vertical-align: middle;
  }
  .spinner {
    width: var(--sp, 12px);
    height: var(--sp, 12px);
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    display: inline-block;
    vertical-align: middle;
    flex: none;
    opacity: 0.85;
    animation: sp-rot 0.7s linear infinite;
  }
  @keyframes sp-rot {
    to {
      transform: rotate(360deg);
    }
  }
</style>
