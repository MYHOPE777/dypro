import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRuntime } from './v2/runtime';
import { createV2Http } from './v2/http';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = createRuntime({ env: process.env, rootDir });
const httpRuntime = createV2Http(runtime);
const { server } = httpRuntime;
const port = Number(process.env.PORT ?? 8787);

server.listen(port, '0.0.0.0', () => {
  console.log(`Live runtime v2 listening on http://localhost:${port}`);
});

let shutdownStarted = false;
const shutdown = (): void => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  void httpRuntime.close()
    .then(() => runtime.close())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[runtime-shutdown]', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
