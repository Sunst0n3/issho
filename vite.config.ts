/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The home server (server/) listens on 8787; in dev, Vite proxies /api to it
// (ISSHO_API_PORT points a second dev copy at another server).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      // The icons are precached by globPatterns below; listing them again (includeAssets, or
      // the manifest's icons) would precache each twice.
      includeManifestIcons: false,
      manifest: {
        id: '/',
        name: 'Issho — Japanese together',
        short_name: 'Issho',
        description: 'Learn Japanese together: kanji writing, reviews, reading and chat.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#F4F0E8',
        theme_color: '#F4F0E8',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // manifest.webmanifest is added by the plugin itself. This includes audio/manifest.json
        // (precompressed by the server) but no voice clip: those are cached at runtime, below.
        globPatterns: ['**/*.{js,css,html,svg,png,json}'],
        // On first install the new service worker takes over the open page, so the app works
        // offline without a reload. Updates still wait for "Reload" (no skipWaiting).
        clientsClaim: true,
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/audio\//],
        runtimeCaching: [
          // Voice clips (about 9,700, 70–80 MB in all) are fetched as they are first played, and in
          // packs per unit and kanji chapter by prefetchPacks() (src/speech/audio.ts), so a phone
          // keeps only what its learner has reached. Their names are content hashes, so a cached
          // clip never goes stale. The cache name is AUDIO_CACHE in audio.ts.
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/audio/') && url.pathname.endsWith('.m4a'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'issho-audio-v1',
              expiration: { maxEntries: 15000 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    proxy: {
      '/api': { target: `http://localhost:${process.env.ISSHO_API_PORT ?? 8787}`, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    // The home server runs in process for the app's integration tests (src/sync/test-server.ts): Node loads it
    // as it does in production, so its import.meta.url is a file URL and its own dependencies resolve.
    server: { deps: { external: [/\/server\/src\//] } },
  },
});
