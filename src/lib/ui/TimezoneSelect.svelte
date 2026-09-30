<script lang="ts">
  import { onMount } from 'svelte';
  export interface TzOption { zone: string; offset: string; offsetMin: number; fixed?: boolean }
  /**
   * A select of every zone the scheduler knows, grouped by region, each with its offset from UTC right now (so Madrid
   * reads "Madrid · UTC+2" and Toronto "Toronto · UTC−4", and the two compare at a glance). Plain offsets (UTC+1, UTC+2…)
   * come first for people who think in numbers; they never move with summer time. With no value it picks the browser's zone.
   */
  let { name = 'timezone', value = '', zones, id = undefined, required = true }: { name?: string; value?: string; zones: TzOption[]; id?: string; required?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  let current = $state(value);
  const city = (z: string) => z.replace(/^[^/]+\//, '').replace(/_/g, ' ');
  const groups = $derived.by(() => {
    const byRegion = new Map<string, TzOption[]>();
    for (const o of zones) {
      if (o.fixed) continue;
      const region = o.zone.includes('/') ? o.zone.slice(0, o.zone.indexOf('/')) : 'Other';
      (byRegion.get(region) ?? byRegion.set(region, []).get(region)!).push(o);
    }
    return [...byRegion.entries()].sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b))).map(([region, list]) => ({ region, zones: list }));
  });
  const fixed = $derived(zones.filter((o) => o.fixed));
  const known = $derived(new Set(zones.map((o) => o.zone)));
  const unlisted = $derived(current && !known.has(current) ? current : '');
  onMount(() => {
    if (current) return;
    try { const mine = Intl.DateTimeFormat().resolvedOptions().timeZone; if (mine) current = mine; } catch { /* leave the choice to the user */ }
  });
  // A form reset (use:enhance resets the form after every successful save) puts a select back on the option marked
  // `selected`, or on its first enabled one, UTC−12, when none is; the next save would then store that. Marking the
  // current zone makes a reset keep it.
  let select: HTMLSelectElement;
  $effect(() => { for (const o of select.options) o.toggleAttribute('selected', o.value === current); });
</script>
<select class="in" {name} {id} bind:value={current} bind:this={select} {required}>
  <option value="" disabled>Choose a timezone…</option>
  {#if unlisted}<option value={unlisted}>{unlisted}</option>{/if}
  {#if fixed.length}
    <optgroup label="UTC offsets · fixed, no summer time">{#each fixed as o}<option value={o.zone}>{o.offset}</option>{/each}</optgroup>
  {/if}
  {#each groups as g}
    <optgroup label={g.region}>{#each g.zones as o}<option value={o.zone}>{g.region === 'Other' ? o.zone : city(o.zone)} · {o.offset}</option>{/each}</optgroup>
  {/each}
</select>
