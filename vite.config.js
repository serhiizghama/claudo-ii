import { defineConfig } from 'vite';

// tools/capture.mjs (TEST-3) drives the dev server headlessly through
// Playwright. The HMR websocket client keeps trying to reconnect against a
// server that a headless harness may tear down between shots, which stalls
// navigation. Set CLAUDO_NO_HMR=1 to boot without the HMR client.
const hmrDisabled = process.env.CLAUDO_NO_HMR === '1';

export default defineConfig({
  // The production build must open as a plain static file tree (no server),
  // so every asset URL is resolved relative to the HTML that loads it.
  base: './',
  server: {
    host: '127.0.0.1',
    hmr: hmrDisabled ? false : undefined,
  },
  preview: {
    host: '127.0.0.1',
  },
});
