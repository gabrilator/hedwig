<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { toast } from '$lib/ui/motion.svelte';
  import Segmented from '$lib/ui/Segmented.svelte';
  let { data, form } = $props();
  const editing = $derived(data.editId === 'new' ? { name: 'Closer', model: data.defaults.model, persona: data.defaults.persona, mode: 'classify', active: true, builtin: false } : data.agents.find((a: any) => a._id === data.editId));
  $effect(() => { if (form?.saved) { toast('Saved'); goto('/agents', { invalidateAll: true }); } if (form?.error) toast(form.error, 'err', 6000); });
</script>
<svelte:head><title>Agents · Hedwig</title></svelte:head>
<div class="top">
  <div><h1 class="disp">Agents</h1><div class="sub">read every reply once, label its sentiment, draft an answer when asked · nothing is ever sent by an agent</div></div>
  <div class="acts"><a class="light" class:on={data.llm.configured} href="/setup"><i></i>{data.llm.configured ? `labels by ${data.llm.jev ? 'Jev' : 'Gemini'} · ${data.llm.today} calls today` : 'no model key'}</a><a class="btn pri" href="/agents?edit=new">+ New agent</a></div>
</div>
{#if !data.llm.configured}<div class="note red" style="margin-bottom:16px"><b>No model key on the server.</b> Agents are stored and shown, but no reply is labelled until <code>TYPESAFE_API_KEY</code> (Jev) or <code>GEMINI_API_KEY</code> is in the server's environment; drafts need <code>GEMINI_API_KEY</code>. See <a href="/setup">setup</a>.</div>{/if}
<div class="grid2">
  <div class="wrap cards">
    <table style="min-width:0">
      <thead><tr><th>Agent</th><th>Model</th><th>Does</th><th>Used by</th><th>State</th></tr></thead>
      <tbody>
        {#each data.agents as a}
          <tr class="row" class:sel={a._id === data.editId} onclick={() => goto(`/agents?edit=${a._id}`)}>
            <td class="full nolbl"><span class="nm">{a.name}{#if a.builtin} <span class="tag">built in</span>{/if}</span>{#if a.persona}<span class="sm">{a.persona.slice(0, 90)}</span>{/if}</td>
            <td data-l="Model">{a.model}</td><td data-l="Does">{a.mode === 'draft' ? 'classify + draft' : 'classify'}</td>
            <td data-l="Used by">{a.usedBy} campaign{a.usedBy === 1 ? '' : 's'}{#if a.builtin && data.campaignsOff} <span class="mute">· {data.campaignsOff} with no agent</span>{/if}</td>
            <td data-l="State"><span class="light" class:on={a.active}><i></i>{a.active ? 'on' : 'off'}</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if editing}
    <form class="panel" method="POST" action="?/save" use:enhance>
      <div class="hd"><h3>{data.editId === 'new' ? 'New agent' : editing.name}</h3><label class="chip" style="cursor:pointer"><input type="checkbox" name="active" checked={editing.active} /> on</label></div>
      <div class="bd stack">
        {#if data.editId !== 'new'}<input type="hidden" name="id" value={editing._id} />{/if}
        <div class="frow">
          <label class="field"><span class="lbl">Name</span><input class="in" name="name" value={editing.name} required /></label>
          <label class="field"><span class="lbl">{data.llm.jev ? 'Model for drafts' : 'Model'}</span><select class="in" name="model">{#each data.models as m}<option value={m.id} selected={editing.model === m.id}>{m.label}</option>{/each}</select></label>
        </div>
        <label class="field"><span class="lbl">Who it is</span><textarea class="in" name="persona" style="min-height:90px;font-family:var(--sans)" placeholder="Optional. Who you are and what you sell, in a few lines. Used for drafts; sentiment works without it.">{editing.persona}</textarea><span class="help">Read by the model before every reply: who you are, your tone, what never to promise. Empty is fine for labelling.</span></label>
        <div class="field"><span class="lbl">What it does with each reply</span><Segmented name="mode" value={editing.mode} options={[{ value: 'classify', label: 'Label it' }, { value: 'draft', label: 'Label it + write a draft' }]} /><span class="help">{data.llm.jev ? 'Jev labels each reply, and the model above labels when Jev can\'t answer; a draft is one more call to it, only for interested, meeting and question replies.' : 'One model call per reply either way.'} A draft appears in the Inbox for you to edit and send; you can also ask for one there, reply by reply. Auto-reply does not exist.</span></div>
        {#if editing.builtin}<div class="note"><b>Built in.</b> Every campaign that has not picked another agent uses this one. It can be switched off, not deleted.</div>{/if}
        <div class="acts"><button class="btn pri sm" type="submit">Save</button>{#if data.editId !== 'new' && !editing.builtin}<button class="btn sm ghost" type="submit" formaction="?/delete" onclick={(e) => { if (!confirm('Delete this agent?')) e.preventDefault(); }}>Delete</button>{/if}<a class="btn sm ghost" href="/agents">Cancel</a></div>
      </div>
    </form>
  {/if}
</div>
