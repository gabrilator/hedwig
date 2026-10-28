<script lang="ts">
  import { enhance } from '$app/forms';
  import { ago } from '$lib/ui/format';
  import { toast } from '$lib/ui/motion.svelte';
  let { data, form } = $props();
  const FILES = [['leads.csv', 'every lead with its status, sends, opens and first reply'], ['daily.csv', 'each campaign per day, last 180 days']];
  const link = (token: string, file: string) => `${data.feedBase}/${token}/${file}`;
  /** Copies the text next to the button; where the clipboard is blocked, selects it for the keyboard instead. */
  async function copy(button: HTMLElement) {
    const code = button.previousElementSibling as HTMLElement;
    try { await navigator.clipboard.writeText(code.textContent ?? ''); toast('Copied'); }
    catch {
      const range = document.createRange(); range.selectNodeContents(code);
      const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      toast('Selected: copy it with your keyboard.');
    }
  }
</script>

<section class="panel" id="feed">
  <div class="hd"><h3>Results feed</h3><span class="light" class:on={!!data.feed}><i></i>{data.feed ? 'On' : 'Off'}</span></div>
  <div class="bd stack" style="font-size:12px;color:var(--mute);line-height:1.6;gap:10px">
    <p style="margin:0">A secret link to {data.space?.name ?? 'this workspace'}'s results as two CSV files, for a spreadsheet or another app to read without signing in. No email text, no passwords.</p>
    {#if form?.feedToken}
      <div class="note green"><b>Copy them now.</b> Hedwig keeps only a fingerprint of the link, so it can't show it again.</div>
      {#each FILES as [file, what]}
        <div class="stack" style="gap:6px">
          <div><b style="color:var(--bone);font-weight:500">{file}</b> · {what}</div>
          <div class="copy"><code>{link(form.feedToken, file)}</code><button class="btn sm" type="button" onclick={(e) => copy(e.currentTarget)}>Copy link</button></div>
          <div class="copy"><code>=IMPORTDATA("{link(form.feedToken, file)}")</code><button class="btn sm ghost" type="button" onclick={(e) => copy(e.currentTarget)}>Copy formula</button></div>
        </div>
      {/each}
    {:else if data.feed}
      <p style="margin:0">Made {ago(data.feed.createdAt)}{data.feed.createdBy ? ` by ${data.feed.createdBy}` : ''} · last read {ago(data.feed.lastUsedAt)}. The link was shown once, when it was made; if it's lost, make a new one.</p>
    {/if}
    {#if form?.feedOff}<p style="margin:0">Feed turned off. Its link no longer works.</p>{/if}
    {#if form?.feedError}<p class="r" style="margin:0">{form.feedError}</p>{/if}
    <div class="acts">
      <form method="POST" action="?/createFeed" use:enhance={({ cancel }) => { if (data.feed && !confirm('Make a new link? The current one stops working, so sheets that use it need the new one.')) cancel(); }}><button class="btn sm" type="submit">{data.feed ? 'Make a new link' : 'Make a link'}</button></form>
      {#if data.feed}<form method="POST" action="?/revokeFeed" use:enhance={({ cancel }) => { if (!confirm('Turn off the feed? Its link stops working at once.')) cancel(); }}><button class="btn sm ghost" type="submit">Turn off</button></form>{/if}
    </div>
    <p style="margin:0">In Google Sheets, paste a formula in a cell: Google fetches the file again about every hour. Anyone with the link can read these leads and numbers, so keep it in the sheet and make a new one if it gets out.</p>
  </div>
</section>

<style>
  .copy { display:flex;gap:8px;align-items:center;min-width:0 }
  .copy code { flex:1;min-width:0;overflow-wrap:anywhere;padding:6px 8px;background:var(--panel2);color:var(--bone) }
</style>
