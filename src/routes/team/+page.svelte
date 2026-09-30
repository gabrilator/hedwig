<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/ui/motion.svelte';
  let { data, form } = $props();
  let renaming = $state<string | null>(null);
  let deleting = $state<string | null>(null);
  let typed = $state('');
  $effect(() => { if (form?.note) { toast(form.note); renaming = null; deleting = null; typed = ''; invalidateAll(); } if (form?.error) toast(form.error, 'err', 6000); });
</script>
<svelte:head><title>Team · Hedwig</title></svelte:head>
<div class="top">
  <div><h1 class="disp">Team</h1><div class="sub">a person can be in no org, one, or several · a campaign or mailbox lives in one org or in your personal space</div></div>
  <form class="acts" method="POST" action="?/createOrg" use:enhance><input class="in" name="name" placeholder="new org name" style="width:200px" required /><button class="btn pri" type="submit">+ New org</button></form>
</div>
<div class="grid2">
  {#each data.orgs as o}
    <div class="orgcard">
      <h4>{o.name} {#if data.space?.key === o.key}<span class="tag ok">current</span>{/if}</h4>
      {#if renaming === o.id}
        <form class="confirm" method="POST" action="?/rename" use:enhance style="margin:0 0 10px"><input type="hidden" name="org" value={o.id} /><input class="in" name="name" value={o.name} required aria-label="New name" /><button class="btn sm pri" type="submit">Rename</button><button class="btn sm ghost" type="button" onclick={() => (renaming = null)}>Cancel</button></form>
      {/if}
      <div class="lbl">{o.campaigns} campaigns · {o.accounts} mailboxes · {o.members.length} member{o.members.length === 1 ? '' : 's'}{#if o.invites.length} · {o.invites.length} invited{/if}</div>
      <div style="margin-top:12px">
        {#each o.members as m}
          <div class="member"><span>{m.email}{#if m.name} <span class="mute">· {m.name}</span>{/if}{#if m.id === data.user?.id} <span class="mute">· you</span>{/if}</span><span class="acts" style="gap:8px">
            <span class="role {m.role}">{m.role}</span>
            {#if o.myRole === 'owner'}<form method="POST" action="?/role" use:enhance><input type="hidden" name="org" value={o.id} /><input type="hidden" name="user" value={m.id} /><input type="hidden" name="role" value={m.role === 'owner' ? 'member' : 'owner'} /><button class="linkbtn mute" type="submit">{m.role === 'owner' ? 'make member' : 'make owner'}</button></form>{/if}
            {#if m.id === data.user?.id}<form method="POST" action="?/remove" use:enhance onsubmit={(e) => { if (!confirm(`Leave ${o.name}?`)) e.preventDefault(); }}><input type="hidden" name="org" value={o.id} /><input type="hidden" name="user" value={m.id} /><button class="linkbtn mute" type="submit">leave</button></form>
            {:else if o.myRole === 'owner'}<form method="POST" action="?/remove" use:enhance><input type="hidden" name="org" value={o.id} /><input type="hidden" name="user" value={m.id} /><button class="linkbtn mute" type="submit">remove</button></form>{/if}
          </span></div>
        {/each}
        {#each o.invites as i}
          <div class="member"><span class="mute">{i.email} · invited</span><span class="acts"><span class="role">pending</span><form method="POST" action="?/cancelInvite" use:enhance><input type="hidden" name="invite" value={i.id} /><button class="linkbtn mute" type="submit">cancel</button></form></span></div>
        {/each}
      </div>
      {#if o.myRole === 'owner'}
        <form class="acts" style="margin-top:14px" method="POST" action="?/invite" use:enhance><input type="hidden" name="org" value={o.id} /><input class="in" name="email" type="email" style="width:auto;flex:1" placeholder="invite by email" required /><button class="btn sm" type="submit">Invite</button></form>
      {/if}
      <div class="acts" style="margin-top:10px">
        {#if data.space?.key !== o.key}<form method="POST" action="?/switch"><input type="hidden" name="space" value={o.key} /><button class="btn sm ghost" type="submit">Switch to {o.name}</button></form>{/if}
        {#if o.myRole === 'owner'}
          <button class="btn sm ghost" type="button" onclick={() => { renaming = renaming === o.id ? null : o.id; }}>Rename</button>
          <button class="btn sm ghost" type="button" onclick={() => { deleting = deleting === o.id ? null : o.id; typed = ''; }}>Delete…</button>
        {/if}
      </div>
      {#if deleting === o.id}
        <form class="note red" method="POST" action="?/deleteOrg" use:enhance style="margin-top:10px">
          <input type="hidden" name="org" value={o.id} />
          <b>This deletes {o.name} for everyone in it:</b> {o.campaigns} campaign{o.campaigns === 1 ? '' : 's'} with their leads and stats, {o.accounts} mailbox connection{o.accounts === 1 ? '' : 's'}, its agents and invitations. Sent emails stay in the mailboxes. There is no undo.
          <div class="confirm"><input class="in" name="confirm" bind:value={typed} placeholder="type {o.name} to confirm" autocomplete="off" /><button class="btn sm red" type="submit" disabled={typed !== o.name}>Delete {o.name}</button><button class="btn sm ghost" type="button" onclick={() => (deleting = null)}>Keep it</button></div>
        </form>
      {/if}
    </div>
  {/each}
  <div class="stack">
    <div class="orgcard">
      <h4>You</h4>
      <div class="lbl">{data.user?.email}</div>
      <form class="confirm" method="POST" action="?/profile" use:enhance style="margin-top:12px"><input class="in" name="name" value={data.user?.name ?? ''} placeholder="your name" required aria-label="Your name" /><button class="btn sm" type="submit">Save name</button></form>
      <form class="confirm" method="POST" action="?/password" use:enhance={() => async ({ update }) => { await update({ reset: true }); }}><input class="in" name="current" type="password" placeholder="current password" autocomplete="current-password" required /><input class="in" name="next" type="password" placeholder="new password (6+)" autocomplete="new-password" minlength="6" required /><button class="btn sm" type="submit">Change password</button></form>
    </div>
    <div class="orgcard">
      <h4>Personal {#if data.space?.kind === 'personal'}<span class="tag ok">current</span>{/if}</h4>
      <div class="lbl">{data.personal.accounts} mailboxes · {data.personal.campaigns} campaigns · only you</div>
      {#if data.space?.kind !== 'personal'}<form method="POST" action="?/switch" style="margin-top:10px"><input type="hidden" name="space" value="user:{data.user?.id}" /><button class="btn sm ghost" type="submit">Switch to Personal</button></form>{/if}
    </div>
  </div>
</div>
