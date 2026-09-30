<script lang="ts">let { data, form } = $props();</script>

<section class="panel" id="connections"><div class="bd stack">
<h3>Assistant connections</h3>
<p>Add this address to Claude Code or Codex. It opens Hedwig's sign-in, where you choose what it may do.</p>
<code style="display:block;padding:18px;background:var(--panel,#eee);overflow-wrap:anywhere">{data.endpoint}</code>
<p class="mute" style="overflow-wrap:anywhere">Claude Code: <code>claude mcp add --transport http hedwig {data.endpoint}</code>, then <code>/mcp</code> to sign in.<br>Codex: <code>codex mcp add hedwig --url {data.endpoint}</code>, then <code>codex mcp login hedwig</code>.</p>
{#if form?.error}<p class="err">{form.error}</p>{/if}
{#if form?.revoked}<p>Connection disconnected.</p>{/if}
{#each data.connections as connection}
<section class="card" style="padding:20px;margin:16px 0"><h2>{connection.clientName}</h2><p>{connection.space}</p><p>{connection.scope.map((s: string) => data.scopeLabels[s] ?? s).join(' · ')}</p><form method="POST" action="?/revoke"><input type="hidden" name="id" value={connection._id}/><button class="btn ghost">Disconnect</button></form></section>
{:else}<p class="mute">Nothing connected yet.</p>{/each}
</div></section>
