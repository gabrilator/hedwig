<script lang="ts">
  let { name, checked = false, labels = ['Off', 'On'], cls = 'blue' }: { name: string; checked?: boolean; labels?: [string, string]; cls?: string } = $props();
  // svelte-ignore state_referenced_locally
  let on = $state(checked);
</script>
<span class="tg {cls}">
  <input type="checkbox" {name} bind:checked={on} style="display:none" />
  <button type="button" class:on={!on} onclick={() => (on = false)}>{labels[0]}</button>
  <button type="button" class:on={on} onclick={() => (on = true)}>{labels[1]}</button>
</span>
