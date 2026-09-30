import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: 'build' }),
    // The form-origin check lives in hooks.server.ts (csrfBlocked): same rule as SvelteKit's, except the unsubscribe page,
    // where mail clients POST the one-click with no Origin and people click from the tracking host.
    csrf: { trustedOrigins: ['*'] }
  }
};
export default config;
