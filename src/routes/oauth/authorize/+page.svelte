<script lang="ts">let { data, form } = $props();</script>
<svelte:head><title>Connect to Hedwig</title></svelte:head>
<div class="page" style="max-width:620px;margin:40px auto;padding:24px">
  <h1>Connect to Hedwig</h1>
  <p><strong>{data.clientName}</strong> wants access to your Hedwig account.</p>
  <p class="mute">This name is supplied by the connecting app. Only continue if you started this connection. You will return to {data.redirectHost}.</p>
  {#if form?.error}<p class="err">{form.error}</p>{/if}
  <form method="POST">
    <p>It reaches every workspace you are in ({data.workspaces.join(', ')}), one at a time. It starts in <b>{data.startsIn}</b>; ask it to switch to another.</p>
    <p>Allow this connection to:</p>
    {#each data.permissions as permission}<label style="display:block;margin:14px 0"><input type="checkbox" name="scope" value={permission.key} checked={true} /> {permission.label}</label>{/each}
    <p class="mute">You can disconnect at any time under MCP. All requested permissions are selected for full control from chat. Uncheck any you do not want to grant. Sending permissions allow campaign launches, tests and replies when you ask.</p>
    <button class="btn" name="decision" value="allow">Connect</button> <button class="btn ghost" name="decision" value="deny">Cancel</button>
  </form>
</div>
