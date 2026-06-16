<script lang="ts">
  import { ICONS } from '../lib/icons';
  import { send } from '../lib/vscode';

  interface Props {
    words: string[];
  }
  let { words }: Props = $props();

  // Clipboard is routed through the host — the webview CSP blocks navigator.clipboard.
  function copy() {
    send('wallet.copy', { text: words.join(' '), note: 'Recovery phrase copied to clipboard' });
  }
</script>

<div class="phrase-grid">
  {#each words as word, i (i)}
    <div class="phrase-cell">
      <span class="phrase-num">{i + 1}</span>
      <span class="phrase-word">{word}</span>
    </div>
  {/each}
</div>
<button class="phrase-copy with-icon" type="button" onclick={copy}>
  {@html ICONS.copy} Copy to clipboard
</button>
