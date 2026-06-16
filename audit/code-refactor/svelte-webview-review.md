# Code Review — Svelte Webview Subsystem

**Date:** 2026-06-16
**Reviewer:** Senior engineering review (Claude)
**Scope:** `src/studio/webview/` (`App.svelte`, `Home`, `Wallets`, `Settings`, `Deploy`, `History`, `Processors`, `Tunnel`, `NetworkMismatchBanner`, `DiagnosisPanel`), `src/studio/webview/lib/` (`vscode`, `icons`, `format`, `Spinner`), shared `src/lib/duration.ts` + `src/lib/network.ts`, and `src/studio/types.ts` (~5,300 lines).
**Constraints:** No business-logic or behavioral changes proposed. Refactors listed are behavior-preserving.

---

## Overall Assessment

A well-structured, mature Svelte 5 webview. It consistently uses runes (`$state`/`$derived`/`$effect`/`$props`), keeps the host/webview boundary clean via a single `send()` helper and `postMessage`, and the trickier reactivity (untracked accumulators, `seeded` input guards, `$state.snapshot` before `postMessage`) is correctly handled **and commented with the reason**, which is rare and valuable. The shared formatting layer (`lib/format` → `lib/duration`) is genuinely good: pure, dependency-free, single canonical unit table, well-documented.

The main weaknesses are **size and duplication concentrated in the two largest components** (`Settings.svelte` 1,179 lines, `History.svelte` 1,105). The pricing/fiat display markup is copy-pasted between `Deploy` and `Settings` and will drift; pure transformation logic (`buildPatch`, validation) is trapped inside a `.svelte` file where it can't be unit-tested; and host→webview messages are cast with `as unknown as` because there's no `OutMsg` union to mirror the existing `InMsg`. None of these are correctness emergencies, but they're what will hurt as the surface grows.

**Verdict: safe to merge.** The findings below are improvements, not blockers.

---

## Strengths

- **Disciplined reactivity.** `History.svelte:119-126` (untrack to avoid `effect_update_depth_exceeded`), `Tunnel.svelte:11-26` (`seeded` so the host echo doesn't fight the caret), `Processors.svelte:79` (`$state.snapshot` before postMessage) — each non-obvious choice is explained.
- **Stale-result guarding.** `Processors.svelte:113-117` and `Settings.svelte:348-356` both refuse to trust a `processorsState` whose `address` doesn't match the wallet currently selected, preventing a real class of race-condition bugs.
- **Clean shared utilities.** `lib/format.ts`, `lib/duration.ts`, `lib/network.ts` are pure, documented, and deliberately shared across both bundles with the rationale written down.
- **Security hygiene.** `{@html}` is confined to the static `ICONS` constants and diagnosis status glyphs — never user data. Svelte auto-escaping is relied on everywhere else, matching the CLAUDE.md rule.
- **Strong type docs.** `types.ts` is thorough and the comments capture domain knowledge (why `expired` is the real lifecycle signal, the `${origin}:${localId}` keying convention, etc.).

---

## Structural Issues

### 1. Pricing + fiat display markup duplicated between `Deploy.svelte` and `Settings.svelte` — **High** · ✅ Resolved 2026-06-16
The "advice" panel (Your price / Suggested / Total) and especially this fiat-conversion fragment are repeated ~12 times across the two files:

```svelte
{#if fiat}{@const f = satoshiToFiat(advice.currentPrice, fiat.acuPriceFiat)}{#if f != null}<span class="pricing-fiat">(~{fmtFiat(f, fiat.currencySign, fiat.currencySymbol)})</span>{/if}{/if}
```

The `nonPriceBlocker` computation, the sufficient/overpaying/insufficient icon+label, and the fallback-reason messages also exist in both files (inline ternaries in `Deploy`, extracted functions `adviceIcon`/`adviceLabel` in `Settings:364-370`).

- **Why it matters:** two copies of pricing logic diverge the moment one is tweaked, silently.
- **Fix (no behavior change):** extract a `{#snippet fiatAmount(value, rate, kind)}` (or `FiatAmount.svelte`) for the repeated fragment, and lift `adviceIcon`/`adviceLabel`/fallback-text into `lib/pricing.ts` so both components call the same functions. Optionally a shared `PricingPanel.svelte`; at minimum unify the leaf helpers.
- **✅ Resolved 2026-06-16:** added `src/studio/webview/lib/FiatNote.svelte` (the fiat-conversion fragment, 12 call sites collapsed) and `src/studio/webview/lib/pricing.ts` (`adviceVerdict()` returning the `AdviceVerdict` `{ icon, label }` via a lookup table, replacing the duplicated icon/label ternaries, plus `isNonPriceBlocker()`). `Deploy.svelte` and `Settings.svelte` now share both. Fallback-reason copy was left per-component — the wording genuinely differs between the two views, so unifying it would have changed rendered text. Verified: `typecheck` + `build:dev` clean.

### 2. Pure config logic trapped inside `Settings.svelte` — **High** (maintainability / testability) · ✅ Resolved 2026-06-16
`buildPatch()` (`:142-222`), `deepMerge` (`:129-140`), `getNested` (`:120-127`), `imField` (`:114-118`), and the `errors` validator (`:224-272`) are pure data transforms with intricate branching (dotted-key expansion, instantMatch array normalization, `reuseKeysFrom` parsing). They are exactly the code that needs unit tests but can't be tested without booting a Svelte component.

- **Fix:** move them to `src/studio/webview/lib/acurastConfig.ts` as exported pure functions and import them. No behavior change; `src/test/unit/` can then cover the SDK-shape normalization that several past commits clearly touched.
- **✅ Resolved 2026-06-16:** extracted `getNested`, `instantMatchField`, `deepMerge` (internal), `buildPatch(draft, project)`, and `validateConfig(draft, project)` into `src/studio/webview/lib/acurastConfig.ts` (named for the whole acurast.json concern — it both builds the save-patch and validates, not just patches). Pure, no Svelte/DOM imports, with the form `draft` and the selected project passed in instead of read from component state. `Settings.svelte` now imports them; `errors` is `validateConfig(draft, currentProject())` and `onSave` calls `buildPatch(draft, currentProject())`. Added `src/test/unit/acurastConfig.test.ts` (19 cases: list parsing, dotted-key expansion, deep-merge onto original, instantMatch Single/Competing normalization, minProcessorVersions cleanup, required-field/Shell/interval/reuseKeysFrom validation). Verified: `typecheck`, `build:dev`, and full `test:unit` (295 tests) all green.

### 3. Job-action cluster (Diagnose / Deregister / DiagnosisPanel) implemented three times — **Medium**
`History.svelte` local cards (`:357-397`), `History.svelte` online cards (`:522-607`), and `Deploy.svelte` job-id cards (`:337-365`) each rebuild the same diagnose button (identical "Diagnosing…/Re-run diagnosis/Diagnose" label logic), deregister button, and `<DiagnosisPanel>`.

- **Fix:** a `JobActions.svelte` taking `{origin, localId, network, dstate, dreg}` collapses three copies into one and guarantees consistent labels/disabled states.

### 4. `Settings.svelte` does six jobs in one file — **Medium**
Fiat-source config, project picker, the config form, `buildPatch`/validation, market-pricing display, and whitelist / "my processors" management all live together. Extracting (1) and (2) pulls ~250 lines out and leaves a mostly-declarative form component.

### 5. No `OutMsg` union for host→webview messages — **Medium**
`App.svelte:113-159` casts nearly every inbound message with `msg as unknown as BalanceMsg`/`PricingStateMsg`/etc. `InMsg` (webview→host) exists and is exhaustive; there is no symmetric union for the reverse direction, so the `switch` is untyped and a renamed field would not be caught by `tsc`.

- **Fix:** define `type OutMsg = RouteMsg | ContextMsg | WalletsStateMsg | …` in `types.ts` and type the handler's `msg` as `OutMsg`, letting the discriminant narrow each case and deleting the `as unknown as` casts.

---

## Logic Review

### 1. Deploy pricing shows the Studio-target symbol, not the project-deploy symbol — **Medium (please verify)**
`App.svelte:220` passes `symbol={wallets.symbol}` to `Deploy`, where `wallets.symbol` follows the **Studio target** (`acurast.network` setting). But per CLAUDE.md, deploy *pricing* follows the **project** `acurast.json` network — and `Settings.svelte:398` correctly derives its symbol from the project network (`'mainnet' ? 'ACU' : 'cACU'`). In the documented mismatch case (project=canary, target=mainnet), Deploy renders canary-priced numbers labelled `ACU`. The numbers come from the project network; only the unit label is wrong. Confirm and, if real, derive Deploy's symbol from `d.network` like Settings does.

### 2. Clearing a numeric field silently writes `null` to the config — **Low–Medium edge case**
The pattern `const n = Number(value); patchField(key, isNaN(n) ? null : n)` (e.g. `Settings:746, 752, 767`) means emptying *Replicas*, *Max cost*, or any usage-limit field stores `null`. Required fields (interval, numberOfExecutions) are caught by `errors`, but `numberOfReplicas`/`maxCostPerExecution`/`usageLimit.*` are not — a user who clears them persists `null`. If the SDK treats `null` as "unset/default" that's fine; if it expects a number this could surprise. Flagging the asymmetry between validated and unvalidated numeric fields.

### 3. `<a href>` external links in `Wallets.svelte` vs `send('openExternal')` everywhere else — **Medium**
`Wallets.svelte:91,93` open funding/faucet pages with raw `<a href="https://…">`, while `Home.svelte:185` deliberately routes the donation link through `send('openExternal', {url})`. In a VS Code webview, plain anchor navigation is frequently blocked by CSP / opens inside the webview frame, so these faucet links may not work. Route them through `openExternal` for consistency and to guarantee they open in the system browser.

### 4. Status badge can go stale — **Low**
`History.svelte:228-234` `jobStatus()` reads `Date.now()` at render time, so a `scheduled` job won't flip to `active` until something else re-renders the list. The live countdown text uses the reactive `now`, but the badge does not. Acceptable, but a long-open History view can show a stale badge.

### 5. Tunnel `seeded` also freezes wallet/network selection — **Low edge case**
`Tunnel.svelte:19-26` seeds `network`/`selectedWalletId` once. The comment justifies this for the suffix (caret), but it also freezes the wallet dropdown — if the active wallet changes elsewhere while the Tunnel view stays mounted, the dropdown keeps the old selection. Probably fine, but the freeze is broader than the comment's stated reason.

### 6. Tunnel debounce timer not cleared on destroy — **Low**
`Tunnel.svelte:28-35` sets a 250ms `setTimeout` with no `$effect`-based cleanup. Navigating away with a pending timer fires `send()` after unmount. Harmless today, but a dangling timer; wrap the debounce in an `$effect` cleanup or clear on destroy.

---

## Maintainability Suggestions

- **Centralize the job key.** `${origin}:${localId}` is built in `App.svelte` (via host `d.key`), inline 3× in `Deploy.svelte` (`:338,358`), and via `diagKey()` in `History.svelte:45`. Add `export const jobKey = (origin, localId) => \`${origin}:${localId}\`` to a lib and use it everywhere so host and webview can't disagree on the format.
- **Drop the misleading `satoshi*` aliases.** `Deploy.svelte:33-34` and `Settings.svelte:361-362` alias `planckToAcu`→`satoshiToACU` and `planckToFiat`→`satoshiToFiat`. The unit is **planck** (Substrate), not satoshi (Bitcoin) — `format.ts` itself documents planck. The alias misnames the unit; import the real names. Same for the local `fmt`/`fmtTime` aliases (`History:224`, `Deploy:35`).
- **Dead field.** `App.svelte`'s `config.projectKey` is always `null` (`:117`) and the real project selection lives in `Settings.svelte`'s own `projectKey` state. Either wire it or drop it from `ConfigState`.
- **Diverging module lists.** `Processors.svelte:27` uses `['DataEncryption','LLM','Shell']`; `Settings.svelte:947` uses `['DataEncryption','LLM']` (Shell auto-injected). Two literals that must stay in sync. A shared constant (with the Shell exception documented) prevents drift.
- **Tighten map types.** `App.svelte:167,175` type `routeIcons`/`routeTitles` as `Record<string, string>`; `Record<Exclude<Route,'home'>, string>` would catch a forgotten entry when a route is added (the CLAUDE.md "new route" checklist currently relies on remembering this manually).
- **Repeated inline link-button styles.** `Deploy.svelte:200-204` and `:208-212` carry an identical 6-property inline `style` for a text-link button. Promote to a `.link-inline` class in `global.css`.

---

## Safe Refactoring Suggestions

All preserve behavior exactly.

1. **Extract `buildPatch`/`deepMerge`/`getNested`/`instantMatchField`/validator to `lib/acurastConfig.ts`** and import into `Settings.svelte`. Pure move; enables unit tests.
2. **Extract the fiat fragment to `{#snippet fiatAmount(...)}`** (or `FiatAmount.svelte`) and reuse in `Deploy` and `Settings`. Identical output, one source of truth.
3. **Introduce `jobKey()`** and replace the inline string-builds and `diagKey`. Mechanical.
4. **Add the `OutMsg` union** and type the `App.svelte` message handler with it; delete the `as unknown as` casts. No runtime change.
5. **Replace `satoshiToACU`/`satoshiToFiat`/`fmt`/`fmtTime` aliases** with the canonical imports. Pure rename.
6. **Lift `JobActions`** into a component shared by `History` (both sections) and `Deploy`.

**Suggested order:** do (1)–(3) first — highest payoff, lowest risk.

---

## Priority Summary

| # | Finding | Type | Priority | Status |
|---|---------|------|----------|--------|
| S1 | Pricing/fiat markup duplicated across Deploy & Settings | Structural | High | ✅ Done (2026-06-16) |
| S2 | Pure config logic trapped in `Settings.svelte` (untestable) | Structural | High | ✅ Done (2026-06-16) |
| S3 | Job-action cluster implemented 3× | Structural | Medium | Open |
| S4 | `Settings.svelte` doing six jobs | Structural | Medium | Open |
| S5 | No `OutMsg` union → `as unknown as` casts | Structural | Medium | Open |
| L1 | Deploy pricing symbol from Studio target, not project network | Logic | Medium (verify) | Open |
| L3 | `<a href>` external links may be CSP-blocked in webview | Logic | Medium | Open |
| L2 | Clearing unvalidated numeric fields writes `null` | Logic | Low–Medium | Open |
| L4 | Status badge can go stale until re-render | Logic | Low | Open |
| L5 | Tunnel `seeded` freezes wallet/network selection | Logic | Low | Open |
| L6 | Tunnel debounce timer not cleared on destroy | Logic | Low | Open |

---

## Final Recommendation

**Safe to merge — recommend minor follow-ups.** No correctness defects block shipping; the webview's reactivity and host boundary are sound. Before the next feature lands on top of `Settings`/`Deploy`, prioritize: (a) verifying the Deploy pricing-symbol vs project-network question (L1), (b) routing the `Wallets` faucet links through `openExternal` (L3), and (c) extracting `buildPatch` + the fiat fragment (Refactor 1–2) so the two large files stop duplicating logic and become testable. Everything else is incremental cleanup.
