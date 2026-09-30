<script lang="ts">
  let dialog: HTMLDialogElement;
  let message = $state('');
  let answer: ((confirmed: boolean) => void) | undefined;

  export function ask(text: string): Promise<boolean> {
    answer?.(false);
    message = text;
    return new Promise(resolve => {
      answer = resolve;
      dialog.showModal();
    });
  }

  function finish(confirmed: boolean) {
    const resolve = answer;
    answer = undefined;
    dialog.close();
    resolve?.(confirmed);
  }
</script>

<dialog bind:this={dialog} aria-labelledby="delete-title" aria-describedby="delete-description" oncancel={(event) => { event.preventDefault(); finish(false); }} onclose={() => { answer?.(false); answer = undefined; }}>
  <h2 id="delete-title">Delete from Inbox?</h2>
  <p id="delete-description">{message}</p>
  <div class="acts">
    <button class="btn ghost" type="button" onclick={() => finish(false)}>Cancel</button>
    <button class="btn red" type="button" onclick={() => finish(true)}>Delete from Inbox</button>
  </div>
</dialog>

<style>
  dialog { max-width:460px;width:calc(100% - 40px);padding:24px;background:var(--panel,#181818);color:var(--bone,#eee);border:1px solid var(--line,#555);border-radius:12px; }
  dialog::backdrop { background:rgb(0 0 0 / 65%); }
  h2 { margin:0 0 12px;font-size:20px; }
  p { line-height:1.5;margin:0 0 20px; }
  .acts { justify-content:flex-end; }
</style>
