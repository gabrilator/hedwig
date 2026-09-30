<script lang="ts">
  import { enhance } from '$app/forms';
  let { data, form } = $props();
  const done = $derived(form?.done || data.done);
</script>
<svelte:head><title>Unsubscribe</title></svelte:head>
<div class="auth">
  <form class="card" method="POST" use:enhance>
    <h1 class="disp" style="font-size:32px">{done ? 'Done' : 'Unsubscribe'}</h1>
    {#if !data.valid}
      <p>This link is not valid any more.</p>
    {:else if done}
      <p>{form?.email || data.email} will not receive more emails from us.</p>
    {:else}
      <p>Stop emails to {data.email}? One click, no login.</p>
      <button class="btn pri" type="submit">Yes, unsubscribe</button>
    {/if}
  </form>
</div>
