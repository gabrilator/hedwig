<script lang="ts">let { data, form } = $props();</script>

<section class="panel" id="connections"><div class="bd stack">
<h3>Assistant connections</h3>
<p>Manage campaigns, messages, tests, mailboxes, agents, lists and your team from your connected assistant. Copy this address into your assistant’s custom connector settings, then sign in and choose permissions.</p>
<code style="display:block;padding:18px;background:var(--panel,#eee);overflow-wrap:anywhere">{data.endpoint}</code>
<p>New connections select all requested permissions by default. To enable newly added controls on an existing connection, disconnect it here and reconnect in your assistant. Passwords and mailbox sign-in stay in the secure setup screens.</p>

{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if form?.revoked}<p>Connection disconnected.</p>{/if}
{#each data.connections as connection}
<section class="card" style="padding:20px;margin:16px 0"><h2>{connection.clientName}</h2><p>{connection.space}</p><p>{connection.scope.map((s: string) => data.scopeLabels[s] ?? s).join(' · ')}</p><form method="POST" action="?/revoke"><input type="hidden" name="id" value={connection._id}/><button class="btn ghost">Disconnect</button></form></section>
{:else}<p>No connected assistants yet.</p>{/each}
</div></section>
