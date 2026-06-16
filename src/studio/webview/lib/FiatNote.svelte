<script lang="ts">
  // Renders the `(~$1.23 USD)` fiat suffix next to an ACU/planck amount.
  // Emits nothing when fiat conversion is unavailable or the value can't be
  // converted — matching the inline `{#if fiat}{@const f}{#if f != null}` guards
  // it replaces, so it's a drop-in for the Deploy and Settings cost panels.
  import type { PricingFiatInfo } from "../../types";
  import { planckToFiat, acuToFiat, fmtFiat } from "./format";

  interface Props {
    /** Planck string when kind='planck', token-unit (ACU/cACU) string when kind='acu'. */
    value: string;
    kind: "planck" | "acu";
    /** Resolved fiat info, or null when conversion is unavailable. */
    fiat: PricingFiatInfo | null;
  }
  let { value, kind, fiat }: Props = $props();

  let amount = $derived(
    fiat
      ? kind === "planck"
        ? planckToFiat(value, fiat.acuPriceFiat)
        : acuToFiat(value, fiat.acuPriceFiat)
      : null,
  );
</script>

{#if fiat && amount != null}<span class="pricing-fiat">(~{fmtFiat(amount, fiat.currencySign, fiat.currencySymbol)})</span>{/if}
