<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import RichEditor from '$lib/ui/RichEditor.svelte';
  import ConfirmDelete from '$lib/ui/ConfirmDelete.svelte';
  import Owl from '$lib/ui/Owl.svelte';
  import { fly, toast } from '$lib/ui/motion.svelte';
  import { ago, fmtDT, labelAi, labelStatus, textToParagraphs } from '$lib/ui/format';
  let { data, form } = $props();
  const link = (patch: Record<string, string | null>) => { const u = new URL(page.url); for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v); } return u.pathname + u.search; };
  const t = $derived(data.thread);
  let body = $state('');
  let nonce = $state('');
  let busy = $state('');
  const newNonce = () => { nonce = crypto.randomUUID(); };
  onMount(newNonce);
  $effect(() => { if (form?.sent) fly(form.note); else if (form?.note) toast(form.note); if (form?.error) toast(form.error, 'err', 7000); });
  const run = (key: string) => () => { busy = key; return async ({ result, update }: any) => { busy = ''; if (key === 'send' && result.type === 'success') { body = ''; newNonce(); } await update({ reset: false }); await invalidateAll(); }; };
  let selected = $state<string[]>([]);
  let deleteConfirmation: ConfirmDelete;
  /** Deleting: after a thread leaves the Inbox, leave the thread pane too, otherwise just refresh what is left. */
  const runDelete = (key: string, message: () => string) => async ({ cancel }: any) => {
    if (busy) { cancel(); return; }
    busy = key;
    if (!await deleteConfirmation.ask(message())) { busy = ''; cancel(); return; }
    return async ({ result, update }: any) => {
      try {
        if (result.type === 'success') selected = [];
        await update({ reset: false });
        if (result.type === 'success' && result.data?.threadGone) await goto(link({ thread: null }), { invalidateAll: true });
      } finally { busy = ''; }
    };
  };
  const threadWord = (n: number) => n === 1 ? 'this thread' : `these ${n} threads`;
  const KEEPS = 'The emails stay in your mailbox; sent messages and the lead status are kept.';
  const pctOf = (x: number | null | undefined) => `${Math.round((x ?? 0) * 100)}%`;
  const STATUS_ROWS = ['replied', 'interested', 'meeting', 'won', 'not_interested', 'question', 'bounced', 'unsubscribed', 'paused', 'contacted', 'opened'];
</script>
<svelte:head><title>Inbox · Hedwig</title></svelte:head>
<ConfirmDelete bind:this={deleteConfirmation} />
{#if form?.error}<div class="flash err" role="alert">{form.error}</div>{/if}
<div class="top">
  <div><h1 class="disp">Inbox</h1><div class="sub">every answer to a campaign of {data.space?.name} · {data.counts.all} threads{#if data.counts.unread} · <b class="r">{data.counts.unread} unread</b>{/if}</div></div>
  <div class="acts"><a class="light" class:on={data.canLabel} href="/agents"><i></i>{data.canLabel ? `reply agent on · labels by ${data.labeller}` : 'reply agent: no key'}</a></div>
</div>
<div class="inbox" class:viewing={!!t}>
  <div class="side-list">
    <div class="lbl h">status</div>
    <a href={link({ status: null, label: null, page: null })} class:on={!data.status && !data.label}><span>All</span><b>{data.counts.all}</b></a>
    <a href={link({ status: 'unread', label: null, page: null })} class:on={data.status === 'unread'}><span>Unread</span><b>{data.counts.unread}</b></a>
    {#each STATUS_ROWS as s}
      {#if s === 'question'}
        {#if data.counts.label.question}<a href={link({ status: null, label: 'question', page: null })} class:on={data.label === 'question'}><span>Question</span><b>{data.counts.label.question}</b></a>{/if}
      {:else if data.counts.status[s] || ['replied', 'interested', 'meeting'].includes(s)}
        <a href={link({ status: s, label: null, page: null })} class:on={data.status === s}><span>{labelStatus(s)}</span><b>{data.counts.status[s] ?? 0}</b></a>
      {/if}
    {/each}
    <div class="lbl h">agent labels</div>
    {#each data.labels as l}
      {#if data.counts.label[l]}<a href={link({ label: l, status: null, page: null })} class:on={data.label === l}><span>{labelAi(l)}</span><b>{data.counts.label[l]}</b></a>{/if}
    {/each}
    {#if !Object.keys(data.counts.label).length}<span class="mute" style="font-size:11px;padding:0 9px">nothing labelled yet</span>{/if}
    <div class="lbl h">campaigns</div>
    <a href={link({ campaign: null, page: null })} class:on={!data.campaignId}><span>All campaigns</span><b>{data.counts.all}</b></a>
    {#each data.campaigns as cp}
      {#if data.counts.campaign[cp.id] || cp.status === 'active'}<a href={link({ campaign: cp.id, page: null })} class:on={data.campaignId === cp.id} title={cp.name}><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{cp.name}</span><b>{data.counts.campaign[cp.id] ?? 0}</b></a>{/if}
    {/each}
  </div>

  <div class="list">
    <form class="filters" method="GET" style="margin-bottom:10px">
      {#if data.status}<input type="hidden" name="status" value={data.status} />{/if}
      {#if data.label}<input type="hidden" name="label" value={data.label} />{/if}
      {#if data.campaignId}<input type="hidden" name="campaign" value={data.campaignId} />{/if}
      {#if t}<input type="hidden" name="thread" value={t.lead._id} />{/if}
      <input class="in" name="q" value={data.q} placeholder="search email, company, subject" aria-label="Search threads" style="flex:1;min-width:120px" />
      <button class="btn sm" type="submit">Search</button>
    </form>
    {#if selected.length}
      <form method="POST" action="?/deleteThreads" use:enhance={runDelete('deleteThreads', () => `Remove ${threadWord(selected.length)} from the Inbox? ${KEEPS}`)} class="acts" style="gap:8px;margin-bottom:10px">
        {#each selected as id}<input type="hidden" name="lead" value={id} />{/each}
        <span class="mute" style="font-size:12px">{selected.length} selected</span><button class="btn sm red" type="submit" disabled={busy === 'deleteThreads'}>{busy === 'deleteThreads' ? 'Removing…' : `Delete ${selected.length === 1 ? 'thread' : `${selected.length} threads`}`}</button><button class="btn sm ghost" type="button" onclick={() => { selected = []; }}>Clear</button>
      </form>
    {/if}
    <div class="panel">
      {#each data.threads as th}
        <div class="thr-row" class:on={t?.lead?._id === th._id}><input type="checkbox" aria-label="Select thread with {th.email}" value={th._id} bind:group={selected} />
        <a class="thr" class:on={t?.lead?._id === th._id} class:unread={th.inboundUnread} href={link({ thread: th._id })}>
          <div class="l1"><span class="who">{th.company || th.email}</span><span class="when">{ago(th.lastInboundAt)}</span></div>
          <div class="l2">{th.lastInbound?.subject || '(no subject)'}</div>
          <div class="l3">{th.company ? th.email + ' · ' : ''}{th.lastInbound?.snippet}</div>
          <div class="tags"><span class="st {th.status}">{labelStatus(th.status)}</span>{#if th.ai?.label}<span class="lab {th.ai.label}">{labelAi(th.ai.label)}</span>{/if}{#if th.lastInbound?.kind && th.lastInbound.kind !== 'reply'}<span class="lab {th.lastInbound.kind}">{th.lastInbound.kind === 'ooo' ? 'out of office' : th.lastInbound.kind}</span>{/if}<span class="cp">{th.campaignName}</span></div>
        </a></div>
      {:else}
        <div class="empty" style="border:0"><Owl size={64} /><div>{data.counts.all === 0 ? 'No answers yet.' : 'Nothing matches.'}</div><div class="mute" style="font-size:12px">{data.counts.all === 0 ? 'Replies, bounces and out-of-office notes to your campaigns land here within two minutes of arriving in the mailbox.' : 'Clear the filters on the left.'}</div></div>
      {/each}
    </div>
    {#if data.pages > 1}
      <div class="pager">
        {#if data.page > 1}<a class="btn sm ghost" href={link({ page: String(data.page - 1) })}>← prev</a>{/if}
        <span>page {data.page} of {data.pages}</span>
        {#if data.page < data.pages}<a class="btn sm ghost" href={link({ page: String(data.page + 1) })}>next →</a>{/if}
      </div>
    {/if}
  </div>

  {#if t}
    <div class="panel tv">
      <div class="hd">
        <div class="who">
          <b>{t.lead.email}</b>
          <span class="lbl">{[t.lead.vars.contactPerson ?? t.lead.vars.firstName, t.lead.vars.companyName ?? t.lead.vars.company].filter(Boolean).join(' · ')}{#if t.campaign} · <a href="/campaigns/{t.campaign.id}/leads?lead={t.lead._id}">{t.campaign.name}</a>{/if}{#if t.mailbox} · via {t.mailbox}{/if}</span>
        </div>
        <div class="acts">
          <form method="POST" action="?/deleteThreads" use:enhance={runDelete('deleteThread', () => `Remove this thread from the Inbox? ${KEEPS}`)}><input type="hidden" name="lead" value={t.lead._id} /><button class="btn sm ghost" type="submit" disabled={busy === 'deleteThread'}>{busy === 'deleteThread' ? 'Removing…' : 'Delete thread'}</button></form>
          <a class="btn sm ghost" href={link({ thread: null })}>close</a>
        </div>
      </div>
      <div class="bd stack">
        <div class="acts">
          <form method="POST" action="?/status" use:enhance={run('status')} class="acts" style="gap:6px">
            <input type="hidden" name="lead" value={t.lead._id} />
            <select class="in" name="status" style="width:auto" aria-label="Lead status">{#each data.statuses as s}<option value={s} selected={s === t.lead.status}>{data.statusLabels[s]}</option>{/each}</select>
            <button class="btn sm" type="submit" disabled={busy === 'status'}>Set status</button>
          </form>
          {#each [['interested', 'Interested', 'pri'], ['meeting', 'Meeting', ''], ['not_interested', 'Not interested', 'ghost']] as [s, label, cls]}
            {#if t.lead.status !== s}<form method="POST" action="?/status" use:enhance={run('status')}><input type="hidden" name="lead" value={t.lead._id} /><input type="hidden" name="status" value={s} /><button class="btn sm {cls}" type="submit">{label}</button></form>{/if}
          {/each}
        </div>

        <div class="aibox" class:off={!t.agent.active || !data.canLabel}>
          <div class="row">
            <span class="light" class:on={t.agent.active && data.canLabel}><i></i>{t.agent.name ?? 'no agent'}</span>
            {#if t.lastReply?.ai?.label}
              <span class="lab {t.lastReply.ai.label}">{labelAi(t.lastReply.ai.label)}</span><span class="num">{pctOf(t.lastReply.ai.confidence)} sure</span>
              {#if t.lastReply.ai.appliedStatus}<span class="mute">· marked {labelStatus(t.lastReply.ai.appliedStatus)}</span>{/if}
            {:else if t.lastReply?.ai?.status === 'pending' || t.lastReply?.ai?.status === 'running'}<span class="mute">reading this reply…</span>
            {:else if t.lastReply?.ai?.status === 'failed'}<span class="r">could not read it: {t.lastReply.ai.error}</span>
            {:else if t.lastReply?.ai?.status === 'skipped'}<span class="mute">not read: {t.lastReply.ai.error}</span>{/if}
          </div>
          {#if t.lastReply?.ai?.reason}<div style="font-family:var(--sans)">{t.lastReply.ai.reason}</div>{/if}
          {#if t.lead.statusBy}<div class="mute">Status set by hand by {t.lead.statusBy}: the agent no longer labels this lead. Label again hands it back.</div>{/if}
          {#if !data.canLabel}<div>No model key on the server yet: add <code>TYPESAFE_API_KEY</code> (Jev) or <code>GEMINI_API_KEY</code> to the environment and restart. Labels start from then on.</div>
          {/if}
          {#if t.lastReply && data.canLabel && t.agent.active}
            <div class="row">
              {#if data.canDraft}<form method="POST" action="?/draft" use:enhance={run('draft')}><input type="hidden" name="lead" value={t.lead._id} /><button class="btn sm" type="submit" disabled={busy === 'draft'}>{busy === 'draft' ? 'Writing…' : t.lastReply.draft ? 'Draft again' : 'Draft an answer'}</button></form>{/if}
              <form method="POST" action="?/classify" use:enhance={run('classify')}><input type="hidden" name="lead" value={t.lead._id} /><button class="btn sm ghost" type="submit" disabled={busy === 'classify'}>{busy === 'classify' ? 'Reading…' : 'Label again'}</button></form>
              <span class="mute" style="font-size:11px">each button is one model call</span>
            </div>
          {/if}
        </div>

        <div class="thread">
          {#each [...t.messages].reverse() as m (m._id)}
            <div class="msg {m.direction} {m.kind}" class:bounce={m.kind === 'bounce'}>
              <div class="m"><span>{m.direction === 'out' ? (m.kind === 'manual' ? 'you · by hand' : m.kind === 'test' ? 'test send' : 'you · sequence') : m.from} · {fmtDT(m.at)}</span><span>{m.kind === 'ooo' ? 'out of office' : m.kind === 'manual' ? (m.status === 'failed' ? 'not sent' : m.status === 'sending' ? 'sending…' : 'sent') : m.kind}{#if m.ai?.label} · {labelAi(m.ai.label)}{/if}{#if m.direction === 'in'} · <form method="POST" action="?/deleteMessage" style="display:inline" use:enhance={runDelete(`deleteMessage:${m._id}`, () => `Remove this message from the Inbox? ${KEEPS}`)}><input type="hidden" name="lead" value={t.lead._id} /><input type="hidden" name="message" value={m._id} /><button class="linkbtn mute" type="submit" disabled={busy === `deleteMessage:${m._id}`}>{busy === `deleteMessage:${m._id}` ? 'removing…' : 'delete'}</button></form>{/if}</span></div>
              {#if m.subject && m.direction === 'in'}<div class="lbl" style="margin-bottom:6px;text-transform:none;letter-spacing:0">{m.subject}</div>{/if}
              {#snippet messageBody()}
              {#if m.html}<div class="body">{@html m.html}</div>{:else}<div class="body" style="white-space:pre-wrap">{m.text.slice(0, 6000)}{m.text.length > 6000 ? '…' : ''}</div>{/if}
              {#if m.opens?.length}<div class="lbl" style="margin-top:8px;letter-spacing:.06em;text-transform:none;color:var(--yellow)">opened ×{m.opens.length} · {m.opens.map((o: string) => fmtDT(o)).join(' · ')}</div>{/if}
              {#if m.error}<div class="r" style="margin-top:6px;font-family:var(--mono);font-size:11px">{m.error}</div>{/if}
              {/snippet}
              {#if m.direction === 'out' && m.kind === 'sent'}
                <details class="original-message"><summary>{m.subject || 'Original sequence email'}</summary>{@render messageBody()}</details>
              {:else}
                {@render messageBody()}
              {/if}
            </div>
          {/each}
        </div>

        {#if t.lastReply?.draft}
          <div class="stack" style="gap:8px">
            <div class="lbl">the agent's draft · not sent · yours to edit</div>
            <div class="draftbox">{t.lastReply.draft}</div>
            <div><button type="button" class="btn sm" onclick={() => { body = textToParagraphs(t.lastReply.draft); }}>Put it in the editor</button></div>
          </div>
        {/if}

        <form class="compose stack" style="gap:10px" method="POST" action="?/reply" use:enhance={run('send')}>
          <input type="hidden" name="lead" value={t.lead._id} />
          <input type="hidden" name="nonce" value={nonce} />
          <div class="lbl">reply{#if t.mailbox} · from {t.mailbox}{/if}</div>
          {#key t.lead._id}<RichEditor bind:value={body} name="body" placeholder="Write the answer… it goes out as a reply in the same thread, with their email quoted below." />{/key}
          <div class="acts" style="justify-content:space-between">
            <span class="help">Sending by hand stops the remaining steps of the sequence for this lead.</span>
            <button class="btn pri sm" type="submit" disabled={busy === 'send' || !t.mailbox || !nonce} title={t.mailbox ? '' : 'No active mailbox for this thread'}>{busy === 'send' ? 'Sending…' : 'Send reply'}</button>
          </div>
        </form>
      </div>
    </div>
  {:else}
    <div class="empty" style="min-height:320px;justify-content:center"><Owl size={72} /><div>Pick a thread.</div></div>
  {/if}
</div>

<style>
  .thr-row { display: flex; align-items: flex-start; }
  .thr-row > input { margin: 12px 0 0 10px; flex: none; }
  .thr-row > .thr { flex: 1; min-width: 0; }
  .original-message { white-space: normal; }
  .original-message summary { cursor: pointer; font-size: 12px; }
  .original-message[open] summary { margin-bottom: 10px; }
</style>
