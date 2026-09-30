<script lang="ts">
  let { name, value, options, cls = '' }: { name: string; value: string; options: { value: string; label: string }[]; cls?: string } = $props();
  // svelte-ignore state_referenced_locally
  let current = $state(value);
</script>
<span class="tg {cls}">
  <input type="hidden" {name} value={current} />
  {#each options as o}<button type="button" class:on={current === o.value} onclick={() => (current = o.value)}>{o.label}</button>{/each}
</span>
