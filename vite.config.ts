import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function portFromEnv(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const serverPort = portFromEnv(env.PORT, 8787);
  const clientPort = portFromEnv(env.CLIENT_PORT, 5173);
  return {
    plugins: [react()],
    build: { outDir: 'dist/client' },
    server: {
      port: clientPort,
      host: '127.0.0.1',
      proxy: {
        '/api': `http://localhost:${serverPort}`,
        '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
      },
    },
  };
});
