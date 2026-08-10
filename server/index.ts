import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRuntime } from './v2/runtime';
import { createV2Http } from './v2/http';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = createRuntime({ env: process.env, rootDir });
const { server } = createV2Http(runtime);
const port = Number(process.env.PORT ?? 8787);

server.listen(port, '0.0.0.0', () => {
  console.log(`Live runtime v2 listening on http://localhost:${port}`);
});

const shutdown = (): void => {
  server.close(async () => {
    await runtime.close();
    process.exit(0);
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
