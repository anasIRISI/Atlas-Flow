import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 127.0.0.1 (not localhost): avoids Node resolving localhost to IPv6 ::1 while the server listens on IPv4.
const BACKEND = `http://127.0.0.1:${process.env.PORT ?? 5679}`;
// Everything the server handles itself; the rest is the React app.
const serverPrefixes = ['/api', '/webhook', '/webhook-test', '/webhook-waiting', '/form', '/form-test', '/form-waiting', '/chat', '/chat-test'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(serverPrefixes.map((p) => [`^${p}(/|$)`, { target: BACKEND, changeOrigin: false }])),
      '/ws': { target: BACKEND, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
