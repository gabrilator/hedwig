<script lang="ts">
  import { enhance } from '$app/forms';
  import Owl from '$lib/ui/Owl.svelte';
  let { form } = $props();
</script>
<svelte:head><title>Sign up · Hedwig</title></svelte:head>
<div class="auth">
  <form class="card" method="POST" use:enhance>
    <Owl size={92} />
    <h1 class="disp">Sign up</h1>
    <p>Your login is yours. The mailboxes you connect later can be anyone's, on any provider.</p>
    {#if form?.error}<div class="flash err">{form.error}</div>{/if}
    <label class="field"><span class="lbl">Name</span><input class="in" name="name" autocomplete="name" value={form?.name ?? ''} /></label>
    <label class="field"><span class="lbl">Email</span><input class="in" name="email" type="email" autocomplete="username" required value={form?.email ?? ''} /></label>
    <label class="field"><span class="lbl">Password</span><input class="in" name="password" type="password" autocomplete="new-password" minlength="6" required /><span class="help">at least 6 characters</span></label>
    <button class="btn pri" type="submit">Create account</button>
    <p>Already have one? <a href="/login">Log in</a></p>
  </form>
</div>
