<script lang="ts">
  import { ICONS } from '../lib/icons';

  interface Props {
    /** Pixel diameter of the avatar circle. */
    size?: number;
  }
  let { size = 30 }: Props = $props();
</script>

<span class="wallet-avatar" style="width:{size}px;height:{size}px;">{@html ICONS.logo}</span>
