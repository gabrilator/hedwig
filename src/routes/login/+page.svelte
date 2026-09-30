<script lang="ts">
  import { enhance } from '$app/forms';
  import Owl from '$lib/ui/Owl.svelte';
  let { form } = $props();
</script>
<svelte:head><title>Log in · Hedwig</title></svelte:head>
<div class="auth">
  <form class="card" method="POST" use:enhance>
    <Owl size={92} />
    <h1 class="disp">Hedwig</h1>
    {#if form?.error}<div class="flash err">{form.error}</div>{/if}
    <label class="field"><span class="lbl">Email</span><input class="in" name="email" type="email" autocomplete="username" required value={form?.email ?? ''} /></label>
    <label class="field"><span class="lbl">Password</span><input class="in" name="password" type="password" autocomplete="current-password" required /></label>
    <button class="btn pri" type="submit">Log in</button>
    <p>No account yet? <a href="/signup">Sign up</a></p>
  </form>
</div>
