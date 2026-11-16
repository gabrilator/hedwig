<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/ui/motion.svelte';
  import { ago } from '$lib/ui/format';
  let { data, form } = $props();
  $effect(() => { if (form?.revoked) { toast('Disconnected'); invalidateAll(); } if (form?.error) toast(form.error, 'err', 6000); });
</script>
<svelte:head><title>MCP · Hedwig</title></svelte:head>
<div class="top"><div><h1 class="disp">MCP</h1><div class="sub">run Hedwig from Claude Code, Codex or any MCP client · connections belong to your account and reach all your workspaces</div></div></div>
<div class="grid2">
  <div class="stack">
    <div class="panel">
      <div class="hd"><h3>Connect an assistant</h3></div>
      <div class="bd stack">
        {#if data.endpoint}
          <p style="margin:0">Add this address to your assistant. It opens Hedwig's sign-in, where you choose what it may do.</p>
          <code style="display:block;padding:14px;overflow-wrap:anywhere">{data.endpoint}</code>
          <p class="mute" style="margin:0;overflow-wrap:anywhere">Claude Code: <code>claude mcp add --transport http hedwig {data.endpoint}</code>, then <code>/mcp</code> to sign in.<br>Codex: <code>codex mcp add hedwig --url {data.endpoint}</code>, then <code>codex mcp login hedwig</code>.</p>
        {:else}
          <div class="note red">{data.endpointProblem}</div>
        {/if}
      </div>
    </div>
    <div class="panel">
      <div class="hd"><h3>What it can do</h3></div>
      <div class="bd" style="font-size:13px;line-height:1.6">
        <p style="margin:0 0 8px">Everything you do on these screens, from chat: campaigns (sequence, schedule, options, mailboxes, test sends, launch and pause), leads, lists, the inbox (labels, replies you ask for), mailbox settings and checks, analytics, the results feed, your team (invitations, roles) and your workspaces. Ask it to switch workspace; it works in one at a time ({data.workspaces.join(', ')}).</p>
        <p class="mute" style="margin:0">Never from chat: mailbox passwords and Microsoft sign-in (connect mailboxes on the Mailboxes screen), your own password, and the server's keys. Launching a campaign and sending a reply are separate permissions.</p>
      </div>
    </div>
  </div>
  <div class="panel" style="align-self:start">
    <div class="hd"><h3>Your connections</h3><span class="mute">{data.connections.length}</span></div>
    <div class="bd stack">
      {#each data.connections as cn (cn.id)}
        <div class="member" style="align-items:flex-start">
          <span><b>{cn.clientName}</b><br><span class="mute" style="font-size:12px">now in {cn.workspace} · connected {ago(cn.createdAt)}</span><br><span class="mute" style="font-size:11px">{cn.scope.map((s: string) => data.scopeLabels[s] ?? s).join(' · ')}</span></span>
          <form method="POST" action="?/revoke" use:enhance onsubmit={(e) => { if (!confirm(`Disconnect ${cn.clientName}?`)) e.preventDefault(); }}><input type="hidden" name="id" value={cn.id} /><button class="btn sm ghost" type="submit">Disconnect</button></form>
        </div>
      {:else}
        <p class="mute" style="margin:0">Nothing connected yet.</p>
      {/each}
    </div>
  </div>
</div>
