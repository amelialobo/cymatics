import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // relative asset paths: the build works at any address, e.g. amelialobo.github.io/cymatics/
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  // three.js is most of the bundle; one chunk is fine for a single-page instrument
  build: { chunkSizeWarningLimit: 1000 },
});
