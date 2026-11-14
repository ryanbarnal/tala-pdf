import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// `--mode desktop` builds the bundle that ships inside the Electron app (no service worker).
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 2500 },
  plugins: [
    VitePWA({
      disable: mode === 'desktop',
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'favicon.svg', 'mark.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Tala PDF',
        short_name: 'Tala PDF',
        description: 'Read, mark up, sign and edit PDFs on your own device.',
        display: 'standalone',
        start_url: './',
        scope: './',
        background_color: '#0f1e3d',
        theme_color: '#0f1e3d',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [{ action: './', accept: { 'application/pdf': ['.pdf'] } }],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,wasm,bcmap,pfb,ttf,woff2,pdf}'],
        // The OCR engine is ~20 MB: fetch it the first time OCR runs, then keep it for offline use.
        globIgnores: ['ocr/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/ocr/'),
            handler: 'CacheFirst',
            options: { cacheName: 'ocr-engine', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
}));
