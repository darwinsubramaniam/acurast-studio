<script lang="ts">
  // Shared "Diagnose" action button used by the Deploy job cards and both
  // History sections. Renders the on-chain-diagnosis trigger with its
  // loading/re-run/idle label states. `.diag-btn` styling lives in global.css.
  import type { DiagnosisStateMsg } from "../types";

  interface Props {
    /** Current diagnosis state for this job, if any. */
    state: DiagnosisStateMsg | undefined;
    /** Label shown before any diagnosis has run (Deploy uses "Why not matched?"). */
    idleLabel?: string;
    onclick: () => void;
  }
  let { state, idleLabel = "Diagnose", onclick }: Props = $props();
</script>

<button class="diag-btn" disabled={state?.status === "loading"} {onclick}>
  {state?.status === "loading"
    ? "Diagnosing…"
    : state
      ? "Re-run diagnosis"
      : idleLabel}
</button>
