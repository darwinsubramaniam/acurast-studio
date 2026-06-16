<script lang="ts">
  import { ICONS } from '../lib/icons';

  interface Props {
    value: string;
    placeholder?: string;
    /** Bound when present so the parent can detect Enter (e.g. submit the gate). */
    onEnter?: () => void;
  }
  let { value = $bindable(''), placeholder = '••••••••••••', onEnter }: Props = $props();

  let show = $state(false);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && onEnter) onEnter();
  }
</script>

<div class="pw-field">
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="pw-input"
    type={show ? 'text' : 'password'}
    bind:value
    {placeholder}
    autocomplete="off"
    spellcheck="false"
    onkeydown={onKey}
  />
  <button
    class="pw-eye"
    type="button"
    onclick={() => (show = !show)}
    title={show ? 'Hide' : 'Show'}
    aria-label={show ? 'Hide password' : 'Show password'}
  >
    {@html show ? ICONS.eyeOff : ICONS.eye}
  </button>
</div>
