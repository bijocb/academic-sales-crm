import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './bootstrap';
import { loadConfig } from './config';
import { resolveDatabaseEnv } from './db-env';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Promise<Handler> | undefined;

/** Serverless entry (Vercel): one Nest app per warm instance, reused across requests. */
export default async function serverless(req: IncomingMessage, res: ServerResponse): Promise<void> {
  handler ??= (async () => {
    resolveDatabaseEnv();
    const app = await createApp(loadConfig());
    await app.init();
    return app.getHttpAdapter().getInstance() as Handler;
  })();
  (await handler)(req, res);
}
