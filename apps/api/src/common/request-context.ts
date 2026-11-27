import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '../auth/principal';

export interface RequestContext {
  correlationId: string;
  ip?: string;
  userAgent?: string;
  principal?: Principal;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
};
