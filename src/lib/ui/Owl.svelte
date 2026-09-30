<script lang="ts">
  import { OWL_BODY } from './owl';
  let { size = 44, label = 'Hedwig' }: { size?: number; label?: string } = $props();
</script>

<span class="owlslot" style:width="{size}px" style:height="{size * 76 / 72}px" aria-label={label} role="img">
  <svg class="owl" viewBox="0 0 72 76" aria-hidden="true">{@html OWL_BODY}</svg>
</span>
