import { fly, toast } from '../../../src/lib/ui/motion.svelte';

/** A page-like effect: when `connected` gets a value, fly the owl and show a toast. Returns how often the effect ran. */
export function flyInEffect() {
  let runs = 0;
  let connected = $state('');
  const stop = $effect.root(() => {
    $effect(() => { if (connected) { runs++; fly(`${connected} connected`); toast('x'); } });
  });
  return {
    connect(address: string) { connected = address; },
    get runs() { return runs; },
    stop
  };
}
