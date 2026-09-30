<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { ago, fmtDT, labelStatus, n } from '$lib/ui/format';
  let { data, form } = $props();
  const cid = $derived(page.params.id);
  const link = (patch: Record<string, string | null>) => { const u = new URL(page.url); for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v); } return u.pathname + u.search; };
  const providerLabel: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', other: 'Other', unknown: '…' };
</script>
{#if form?.error}<div class="flash err">{form.error}</div>{/if}


{#if data.imported}<div class="flash ok">{data.imported}</div>{/if}
{#if data.counts.total > 0}
  {@const ov = data.overview}
  <details class="panel" style="margin-bottom:14px" open={!!data.imported}>
    <summary class="hd" style="cursor:pointer;list-style:none"><h3>Your list · {n(data.counts.total)} leads</h3><span class="lbl">{ov.providers.google ?? 0} Google · {ov.providers.microsoft ?? 0} Microsoft · {ov.providers.other ?? 0} other · {ov.providers.unknown ?? 0} not looked up yet</span></summary>
    <div class="bd grid3">
      <div>
        <div class="lbl" style="margin-bottom:6px">variables · share of leads that have a value</div>
        <div class="vars">{#each ov.variables as v}<span class="var" title="{v.pct}% of leads">{'{{' + v.key + '}}'} <span class="mute">{v.pct}%</span></span>{/each}</div>
        <div class="help" style="margin-top:8px">{ov.withFirstName} of {n(data.counts.total)} have a first name. Missing variables fall back to whatever you write after the | in the email, like {'{{firstName|equipo}}'}.</div>
      </div>
      <div>
        <div class="lbl" style="margin-bottom:6px">where they read mail</div>
        <div class="counts" style="margin:0;box-shadow:none"><div><b>{ov.providers.google ?? 0}</b>Google</div><div><b>{ov.providers.microsoft ?? 0}</b>Microsoft</div><div><b>{ov.providers.other ?? 0}</b>own server</div><div><b>{ov.providers.unknown ?? 0}</b>?</div></div>
        <div class="help" style="margin-top:8px">Looked up from each domain's MX record after import. Own servers track opens worst.</div>
      </div>
      <div>
        <div class="lbl" style="margin-bottom:6px">biggest domains</div>
        <div class="wrap"><table style="min-width:0;font-size:12px"><tbody>{#each ov.topDomains as d}<tr><td>{d.domain}</td><td class="rt num">{d.n}</td></tr>{/each}</tbody></table></div>
      </div>
    </div>
  </details>
{/if}
<div class="counts">
  <a href={link({ status: null, curious: null, page: null })} class:on={!data.status && !data.curious}><b>{n(data.counts.total)}</b>total</a>
  {#each ['queued', 'contacted', 'opened', 'replied', 'interested', 'meeting', 'won', 'not_interested', 'bounced', 'unsubscribed', 'paused'] as s}
    {@const cnt = (data.counts as Record<string, number>)[s] ?? 0}
    {#if cnt || s === 'queued' || s === 'contacted' || s === 'replied'}
      <a href={link({ status: s, curious: null, page: null })} class:on={data.status === s}><b>{n(cnt)}</b>{labelStatus(s)}</a>
    {/if}
  {/each}
  <a href={link({ curious: '1', status: null, page: null })} class:on={data.curious} title="Opened more often than they got emails, and never replied"><b>{n(data.curiousCount)}</b>curious</a>
</div>
<form class="filters" method="GET">
  <input class="in" name="q" placeholder="search email or company" value={data.q} aria-label="Search leads" />
  {#if data.status}<input type="hidden" name="status" value={data.status} />{/if}
  {#if data.curious}<input type="hidden" name="curious" value="1" />{/if}
  <button class="btn sm" type="submit">Search</button>
  <span style="flex:1"></span>
  <a class="btn" href="/campaigns/{cid}/leads/import">Import CSV / Excel</a>
</form>
<div class="leads" class:single={!data.drawer}>
  <div>
    <div class="wrap cards">
      <table>
        <thead><tr><th>Email</th><th>Company</th><th>Provider</th><th>Step</th><th>Status</th><th>Last event</th></tr></thead>
        <tbody>
          {#each data.leads as l}
            <tr class="row" class:sel={data.drawer?.lead?._id === l._id} onclick={() => (location.href = link({ lead: l._id }))}>
              <td class="full nolbl"><span class="nm">{l.email}</span>{#if l.vars.firstName || l.vars.contactPerson}<span class="sm">{l.vars.contactPerson ?? l.vars.firstName}</span>{/if}</td>
              <td data-l="Company">{l.company}</td>
              <td data-l="Provider">{providerLabel[l.provider] ?? l.provider}</td>
              <td data-l="Step" class="num">{l.currentStep} / {data.campaign.steps.length}</td>
              <td data-l="Status"><span class="st {l.status}">{labelStatus(l.status)}</span>{#if l.curious} <span class="lab curious">curious</span>{/if}{#if l.openCount}<span class="sm">opened ×{l.openCount} · {ago(l.lastOpenedAt)}</span>{/if}</td>
              <td data-l="Last event" class="mute">{l.lastEventAt ? ago(l.lastEventAt) : l.nextDueAt ? `due ${fmtDT(l.nextDueAt)}` : 'waiting'}</td>
            </tr>
          {:else}
            <tr><td colspan="6" class="mute">{data.total === 0 && !data.status && !data.curious && !data.q ? 'No leads yet. Import a CSV.' : 'Nothing matches.'}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if data.pages > 1}
      <div class="pager">
        {#if data.page > 1}<a class="btn sm ghost" href={link({ page: String(data.page - 1) })}>← prev</a>{/if}
        <span>page {data.page} of {data.pages} · {n(data.total)} leads</span>
        {#if data.page < data.pages}<a class="btn sm ghost" href={link({ page: String(data.page + 1) })}>next →</a>{/if}
      </div>
    {/if}
  </div>
  {#if data.drawer}
    {@const d = data.drawer}
    <div class="panel">
      <div class="hd"><h3 style="overflow:hidden;text-overflow:ellipsis">{d.lead.email}</h3><span class="st {d.lead.status}">{labelStatus(d.lead.status)}</span></div>
      <div class="bd stack">
        <div class="lbl">{d.lead.vars.contactPerson ?? d.lead.vars.firstName ?? ''} {d.lead.vars.companyName ?? d.lead.vars.company ?? ''} · step {d.lead.currentStep} of {data.campaign.steps.length}{#if d.account} · via {d.account}{/if}</div>
        <form method="POST" action="?/curious" use:enhance={() => async ({ update }) => { await update({ reset: false }); }} class="acts" style="gap:8px">
          <input type="hidden" name="lead" value={d.lead._id} /><input type="hidden" name="on" value={d.lead.curious ? '0' : '1'} />
          {#if d.lead.curious}<span class="lab curious">curious</span>{/if}
          <span class="mute" style="font-size:12px">{d.lead.openCount ?? 0} open{d.lead.openCount === 1 ? '' : 's'} on {d.lead.currentStep} email{d.lead.currentStep === 1 ? '' : 's'}{#if d.lead.curiousBy} · {d.lead.curiousBy === 'rule' ? (d.lead.curious ? 'marked by the daily check' : 'cleared by a reply') : `${d.lead.curious ? 'set' : 'reset'} by ${d.lead.curiousBy}`}{/if}</span>
          <button class="btn sm ghost" type="submit">{d.lead.curious ? 'Not curious' : 'Mark curious'}</button>
        </form>
        {#if d.messages.length}
          <div class="thread">
            {#each d.messages as m}
              <div class="msg {m.direction}" class:bounce={m.kind === 'bounce'}><div class="m"><span>{m.direction === 'out' ? 'you' : m.from} · {fmtDT(m.at)}</span><span>{m.kind}{#if m.opens?.length} · opened ×{m.opens.length}{/if}</span></div>{m.text.slice(0, 1500)}{m.text.length > 1500 ? '…' : ''}{#if m.opens?.length}<div class="lbl" style="margin-top:8px;letter-spacing:.06em;text-transform:none;color:var(--yellow)">opened {m.opens.map((o: string) => fmtDT(o)).join(' · ')}</div>{/if}</div>
            {/each}
          </div>
        {:else}
          <div class="note">No email yet.{#if d.pending} Step {d.pending.stepIndex + 1} is booked for {fmtDT(d.pending.dueAt)} from {d.pending.account}.{/if}</div>
        {/if}
        {#if d.pending && d.messages.length}<div class="lbl">next: step {d.pending.stepIndex + 1} · {fmtDT(d.pending.dueAt)}</div>{/if}
        <form method="POST" action="?/status" use:enhance={() => async ({ update }) => { await update(); await invalidateAll(); }} class="acts">
          <input type="hidden" name="lead" value={d.lead._id} />
          <select class="in" name="status" style="width:auto">{#each data.statuses as s}<option value={s} selected={s === d.lead.status}>{data.labels[s]}</option>{/each}</select>
          <button class="btn sm pri" type="submit">Set status</button>
        </form>
        <div class="acts">
          <form method="POST" action="?/status" use:enhance><input type="hidden" name="lead" value={d.lead._id} /><input type="hidden" name="status" value="interested" /><button class="btn sm" type="submit">Interested</button></form>
          <form method="POST" action="?/status" use:enhance><input type="hidden" name="lead" value={d.lead._id} /><input type="hidden" name="status" value="not_interested" /><button class="btn sm ghost" type="submit">Not interested</button></form>
          <form method="POST" action="?/status" use:enhance><input type="hidden" name="lead" value={d.lead._id} /><input type="hidden" name="status" value="paused" /><button class="btn sm ghost" type="submit">Pause</button></form>
          <form method="POST" action="?/remove" use:enhance={() => async ({ result, update }) => { if (result.type === 'success') location.href = link({ lead: null }); else await update(); }}><input type="hidden" name="lead" value={d.lead._id} /><button class="btn sm ghost" type="submit">Remove</button></form>
        </div>
        <details><summary class="lbl" style="cursor:pointer">variables</summary>
          <div class="wrap" style="margin-top:8px"><table style="min-width:0"><tbody>{#each Object.entries(d.lead.vars) as [k, v]}<tr><td class="mute">{k}</td><td>{v}</td></tr>{/each}</tbody></table></div>
        </details>
        <a class="lbl" href={link({ lead: null })}>close</a>
      </div>
    </div>
  {/if}
</div>
<style>
  .leads.single { grid-template-columns: 1fr; }
</style>
