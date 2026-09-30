<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import RichEditor from '$lib/ui/RichEditor.svelte';
  import { fly, toast } from '$lib/ui/motion.svelte';
  let { data, form } = $props();
  type Step = { subject: string; body: string; delayDays: number };
  // svelte-ignore state_referenced_locally
  let steps = $state<Step[]>(data.editorSteps.map((s: Step) => ({ ...s })));
  let current = $state(0);
  let dirty = $state(false);
  let testing = $state(false);
  let editor: RichEditor | undefined = $state();
  // svelte-ignore state_referenced_locally
  let loadedFor = JSON.stringify(data.editorSteps);
  $effect(() => {
    const key = JSON.stringify(data.editorSteps);
    if (key !== loadedFor) { loadedFor = key; steps = data.editorSteps.map((s: Step) => ({ ...s })); dirty = false; if (current > steps.length - 1) current = steps.length - 1; }
  });
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const words = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  function addStep() { steps.push({ subject: '', body: '', delayDays: 3 }); current = steps.length - 1; dirty = true; }
  function removeStep(i: number) { if (steps.length <= 1) return; if (!confirm(`Delete step ${i + 1}?`)) return; steps.splice(i, 1); current = Math.min(current, steps.length - 1); dirty = true; }
  const payload = $derived(JSON.stringify(steps));
  $effect(() => { if (form?.testOk) fly(form.testOk); if (form?.testError) toast(form.testError, 'err', 7000); if (form?.saved) toast('Sequence saved'); if (form?.error) toast(form.error, 'err', 6000); });
</script>
<div class="seq">
  <div>
    {#each steps as s, i}
      {#if i > 0}<div class="wait">wait {s.delayDays} day{s.delayDays === 1 ? '' : 's'}</div>{/if}
      <button type="button" class="step" class:on={i === current} onclick={() => (current = i)} style="width:100%;text-align:left">
        <div class="h"><span>Step {i + 1}</span><span>{words(s.body) ? `${words(s.body)} words` : 'empty'}</span></div>
        <div class="s" class:mute={!s.subject}>{s.subject || (i === 0 ? 'no subject yet' : '↳ same thread as step 1')}</div>
      </button>
    {/each}
    <div style="margin-top:12px"><button class="btn ghost sm" type="button" onclick={addStep}>+ Add step</button></div>
    <div class="note" style="margin-top:14px"><b>Threading.</b> A step with no subject is sent as a reply to your own previous email, so the person sees one conversation, not several cold emails.</div>
  </div>
  {#if steps[current]}
    <div class="panel editor">
      <div class="hd"><h3>Step {current + 1}{#if current > 0} · +{steps[current].delayDays} days{/if}</h3>
        <div class="vars"><span class="lbl">insert</span>{#each data.variables as v}<button type="button" class="var" onmousedown={(e) => e.preventDefault()} onclick={() => { editor?.insertText(`{{${v}}}`); dirty = true; }}>{'{{' + v + '}}'}</button>{/each}</div>
      </div>
      <form class="bd stack" method="POST" action="?/saveAll" use:enhance={() => async ({ update }) => { await update({ reset: false }); await invalidateAll(); }}>
        <input type="hidden" name="steps" value={payload} />
        <div class="frow">
          <label class="field" style="grid-column: 1 / -1"><span class="lbl">Subject{#if current > 0} <span class="mute">(leave empty to reply in the same thread)</span>{/if}</span><input class="in" bind:value={steps[current].subject} oninput={() => (dirty = true)} placeholder={current > 0 ? 'empty = same thread as step 1' : 'A quick question for {{companyName}}'} /></label>
          {#if current > 0}<label class="field"><span class="lbl">Send this step</span><div class="acts"><input class="in num" type="number" min="0" max="90" bind:value={steps[current].delayDays} oninput={() => (dirty = true)} style="width:90px" /><span class="mute">days after step {current}</span></div></label>{/if}
        </div>
        <div class="field"><span class="lbl">Body</span>
          {#key current}
            <RichEditor bind:this={editor} bind:value={steps[current].body} />
          {/key}
          <span class="help">Bold, italic, links and lists travel as HTML; a plain-text copy goes along for clients that want it. Variables work anywhere, including the subject and link text.</span>
        </div>
        <div class="ft">
          <div class="acts"><span class="lbl">{dirty ? 'unsaved changes' : 'saved'}</span></div>
          <div class="acts">
            {#if steps.length > 1}<button class="btn sm ghost" type="button" onclick={() => removeStep(current)}>Delete this step</button>{/if}
            <button class="btn pri sm" type="submit" onclick={() => { dirty = false; }}>Save all steps</button>
          </div>
        </div>
      </form>
      <div class="bd" style="border-top:1px solid var(--line)">
        {#if data.missingVars.length}
          <div class="note red" style="margin-bottom:12px"><b>{data.missingVars.map((v: string) => `{{${v}}}`).join(', ')} {data.missingVars.length === 1 ? 'is' : 'are'} in your emails but none of your leads has {data.missingVars.length === 1 ? 'it' : 'them'}.</b> Your leads have: {data.variables.map((v: string) => `{{${v}}}`).join(', ')}. Rename the variable here, or re-import naming the column that way.</div>
        {/if}
        <form class="acts" method="POST" action="?/test" use:enhance={() => { testing = true; return async ({ update }) => { testing = false; await update({ reset: false }); }; }}>
          <input type="hidden" name="step" value={current} />
          <input class="in" name="to" value={data.testTo} style="width:240px" aria-label="Test recipient" />
          {#if data.accounts.length > 1}<select class="in" name="account" style="width:auto">{#each data.accounts as a}<option value={a._id}>{a.address}</option>{/each}</select>{/if}
          <button class="btn sm" class:pri={!dirty && data.accounts.length} type="submit" disabled={dirty || !data.accounts.length || testing} title={dirty ? 'Save first' : !data.accounts.length ? 'Connect a mailbox first' : ''}>{testing ? 'Sending…' : `Send test of step ${current + 1}`}</button>
          <span class="mute" style="font-size:11px">rendered with {data.previewEmail}</span>
        </form>
        {#if form?.testOk}<div class="test" style="margin-top:10px"><span class="ok">✓ sent</span><span>{form.testOk}</span></div>{/if}
        {#if form?.testError}<div class="test" style="margin-top:10px;border-color:var(--red)"><span class="fail">✗ not sent</span><span>{form.testError}</span></div>{/if}
        {#if data.testLog.length}
          <details style="margin-top:10px"><summary class="lbl" style="cursor:pointer">recent test sends ({data.testLog.length})</summary>
            <div class="wrap" style="margin-top:8px"><table style="min-width:0;font-size:12px"><tbody>{#each data.testLog as t}<tr><td class="mute num">{fmt(t.at)}</td><td>{t.to}</td><td class="mute">from {t.from}</td><td class="mute" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{t.subject}</td></tr>{/each}</tbody></table></div>
          </details>
        {/if}
        {#if data.previews[current] && !dirty}
          <div class="stack" style="margin-top:14px">
            <div class="lbl">preview · plain-text version</div>
            <div class="msg out" style="color:var(--bone)"><div class="m"><span>Subject: {data.previews[current].subject || '(same thread)'}</span>{#if data.previews[current].missing.length}<span class="r">missing: {data.previews[current].missing.join(', ')}</span>{/if}</div>{data.previews[current].text}</div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
