<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children, label = 'More information' }: { children: Snippet; label?: string } = $props();
  let open = $state(false);
</script>
<span class="info">
  <button type="button" class="ibtn" aria-label={label} aria-expanded={open} onclick={() => (open = !open)}>i</button>
  {#if open}
    <div class="ipop" role="dialog">
      <button type="button" class="iclose" aria-label="Close" onclick={() => (open = false)}>✕</button>
      {@render children()}
    </div>
  {/if}
</span>
<style>
  .info { position: relative; display: inline-block; }
  .ibtn { width: 22px; height: 22px; border: 2px solid var(--mute); color: var(--mute); background: none; font: 600 12px var(--mono); cursor: pointer; }
  .ibtn:hover, .ibtn[aria-expanded="true"] { border-color: var(--hot); color: var(--hot); }
  .ipop { position: absolute; right: 0; top: 30px; width: min(440px, 88vw); background: var(--panel); border: 2px solid var(--bone); padding: 14px 16px; font-size: 12px; line-height: 1.55; color: var(--mute); z-index: 20; box-shadow: 6px 6px 0 var(--shadow), 0 24px 48px -20px rgba(0,0,0,.8); }
  .ipop :global(b) { color: var(--bone); font-weight: 500; }
  .iclose { position: absolute; right: 8px; top: 6px; background: none; border: 0; color: var(--mute); cursor: pointer; font: 12px var(--mono); }
</style>
