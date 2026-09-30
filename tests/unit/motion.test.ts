// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fly, motion } from '../../src/lib/ui/motion.svelte';
import { flyInEffect } from './helpers/flyInEffect.svelte';

const settle = () => new Promise((r) => setTimeout(r, 50)); // effects flush on a microtask; give them a moment

/** The Emails and Sequence pages call fly() from inside a $effect. That must run once, not until Svelte's flush guard trips. */
describe('fly() and toast() inside a $effect', () => {
  it('runs the effect once per trigger instead of re-triggering itself', async () => {
    const h = flyInEffect();
    await settle();
    expect(h.runs).toBe(0);
    h.connect('hey@example.com');
    await settle();
    expect(h.runs).toBe(1);
    expect(motion.flying).toBe(true);
    h.stop();
  });
  it('gives every flight a fresh key', () => {
    const before = motion.flightKey;
    fly(); fly();
    expect(motion.flightKey).toBe(before + 2);
  });
});
