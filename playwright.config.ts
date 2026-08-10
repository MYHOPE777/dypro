import { defineConfig, devices } from '@playwright/test';

const port = 8797;
const runId = `${Date.now()}-${process.pid}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `PORT=${port} V2_DB_PATH=.data-v2-e2e/app-${runId}.sqlite V2_AUDIO_DIR=.data-v2-e2e/audio-${runId} npm start`,
    url: `http://127.0.0.1:${port}/api/v2/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
