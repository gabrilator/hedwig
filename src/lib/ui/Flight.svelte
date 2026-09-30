<script lang="ts">
  import { motion } from './motion.svelte';
  import { LETTER, OWL_BODY } from './owl';
</script>

{#if motion.flying}
  {#key motion.flightKey}
    <div class="flight go" aria-hidden="true" onanimationend={(e) => { if (e.target === e.currentTarget) motion.flying = false; }}>
      <svg class="owl" viewBox="0 0 72 112">{@html OWL_BODY}{@html LETTER}</svg>
    </div>
  {/key}
{/if}
{#if motion.toast}
  <div class="toast" class:err={motion.toastKind === 'err'} role="status" aria-live="polite">{motion.toast}</div>
{/if}
