<script lang="ts">
  import { page } from '$app/state';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/ui/motion.svelte';
  let { data, children } = $props();
  const tabs = ['analytics', 'leads', 'sequence', 'schedule', 'options', 'agent'];
  const cur = $derived(page.url.pathname.split('/')[3] ?? 'analytics');
  let renaming = $state(false);
  let nameInput: HTMLInputElement | undefined = $state();
  $effect(() => { if (renaming) nameInput?.select(); });
</script>
<svelte:head><title>{data.campaign.name} · Hedwig</title></svelte:head>
<div class="top">
  <div>
    <div class="lbl"><a href="/campaigns">← campaigns</a></div>
    {#if renaming}
      <form class="acts" method="POST" action="/campaigns/{data.campaign._id}/options?/rename" style="margin-top:6px" use:enhance={() => async ({ result, update }) => { if (result.type === 'success') { renaming = false; toast('Renamed'); await invalidateAll(); } else await update(); }}>
        <input class="in" name="name" value={data.campaign.name} required bind:this={nameInput} style="width:min(420px,80vw);font-family:var(--disp);font-size:24px;text-transform:uppercase" aria-label="Campaign name" onkeydown={(e) => { if (e.key === 'Escape') renaming = false; }} />
        <button class="btn sm pri" type="submit">Save</button><button class="btn sm ghost" type="button" onclick={() => (renaming = false)}>Cancel</button>
      </form>
    {:else}
      <h1 class="disp" style="font-size:36px;margin-top:6px">{data.campaign.name} <button type="button" class="linkbtn mute" style="font:11px var(--mono);letter-spacing:.12em;text-transform:uppercase;vertical-align:middle;margin-left:6px" onclick={() => (renaming = true)}>rename</button></h1>
    {/if}
    <div class="sub"><span class="pill {data.campaign.status}">{data.campaign.status}</span> &nbsp; {data.counts.total} leads · {data.campaign.steps.length} step{data.campaign.steps.length === 1 ? '' : 's'} · {data.accountsUsed.map((a: any) => a.address).join(', ') || 'no mailbox yet'} · {data.campaign.schedule.from}–{data.campaign.schedule.to} {data.campaign.schedule.timezone}{#if data.campaign.status === 'active'} · {data.windowNote}{/if}</div>
  </div>
  <div class="acts">
    <a class="light" class:on={data.agent?.active} href="/campaigns/{data.campaign._id}/agent" title="Reply agent on this campaign"><i></i>{data.agent ? `${data.agent.name} ${data.agent.active ? 'on' : 'off'}` : 'no agent'}</a>
    {#if data.campaign.status === 'active'}
      <form method="POST" action="/campaigns/{data.campaign.id ?? data.campaign._id}/options?/pause"><button class="btn">Pause campaign</button></form>
    {:else if data.campaign.status === 'paused'}
      <form method="POST" action="/campaigns/{data.campaign._id}/options?/resume"><button class="btn blue">Resume</button></form>
    {:else if data.campaign.status === 'draft'}
      <form method="POST" action="/campaigns/{data.campaign._id}/options?/activate"><button class="btn pri" disabled={data.problems.length > 0} title={data.problems.join(' ')}>Activate</button></form>
    {/if}
  </div>
</div>
{#if data.campaign.status === 'draft' && data.problems.length}
  <div class="note" style="margin-bottom:16px"><b>Before this campaign can go live:</b> {data.problems.join(' ')}</div>
{/if}
<div class="tabs">
  {#each tabs as t}<a href="/campaigns/{data.campaign._id}/{t}" class:on={cur === t}>{t}</a>{/each}
</div>
{#if data.campaign.status === 'active'}<div class="note" style="margin:16px 0;padding:12px;border:1px solid var(--line,#ddd)">Pause this campaign in Options before changing recipients, sequence or schedule.</div>{/if}
  {@render children()}
