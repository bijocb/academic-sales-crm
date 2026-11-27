import 'reflect-metadata';
import { createApp } from './bootstrap';
import { loadConfig } from './config';
import { resolveDatabaseEnv } from './db-env';

async function main(): Promise<void> {
  resolveDatabaseEnv();
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.API_PORT);
}

void main();
