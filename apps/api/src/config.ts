import { z } from '@crm/contracts';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce
      .number()
      .int()
      .default(Number(process.env.PORT ?? 4000)),
    /** Reverse proxies in front of the API (Railway edge = 1; Vercel rewrite + Railway = 2). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
    APP_DATABASE_URL: z.string().min(1),
    /** Optional until background jobs arrive (Phase 6/7). */
    REDIS_URL: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** Requests per minute per signed-in session (anonymous: per IP + e-mail, or IP). */
    THROTTLE_PER_MINUTE: z.coerce.number().int().min(30).max(1_000_000).default(300),
    /** Requests per minute per client IP — a flood ceiling, high enough for an office behind one NAT. */
    THROTTLE_IP_PER_MINUTE: z.coerce.number().int().min(100).max(10_000_000).default(3000),
    /** Lead intake requests per minute per intake key. */
    INTAKE_PER_MINUTE: z.coerce.number().int().min(10).max(1_000_000).default(120),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    SMTP_URL: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    MAIL_FROM: z.string().default('Academic CRM <no-reply@example.com>'),
    /**
     * DEMO/STAGING ONLY: allow running without SMTP in production mode; emails are written
     * to the server log and NOT delivered. Never set on a real customer deployment.
     */
    ALLOW_LOG_MAILER: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    /** Shared secret for the scheduler calling /internal/tick (Vercel Cron / GitHub Actions). */
    CRON_SECRET: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .refine(
        (v) => v === undefined || v.length >= 32,
        'CRON_SECRET must be at least 32 characters',
      ),
    /** `interval`: run background jobs in-process (long-lived server). `off`: only via /internal/tick. */
    WORKER_MODE: z.enum(['interval', 'off']).optional(),
    WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(15_000),
    /** DEVELOPMENT/TEST sandbox gateway webhook secret (the sandbox never runs in production). */
    SANDBOX_GATEWAY_SECRET: z.string().min(16).default('sandbox-gateway-secret-dev-only'),
    /** Meta Lead Ads (A-047). Without META_APP_SECRET the Meta webhook is switched off. */
    META_APP_SECRET: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    META_VERIFY_TOKEN: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    META_GRAPH_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .default('v23.0'),
    /** 32-byte key (base64 or hex) that encrypts stored third-party tokens (AES-256-GCM). */
    SECRETS_KEY: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    /** Optional Expo access token when "enhanced push security" is on for the Expo project. */
    EXPO_ACCESS_TOKEN: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    /** Management assistant (A-052): Claude API key. Without it production has no assistant. */
    ANTHROPIC_API_KEY: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    /** Outside production the labelled sandbox answers unless this is "anthropic" (and a key is set). */
    ASSISTANT_PROVIDER: z.enum(['sandbox', 'anthropic']).optional(),
    ENABLE_API_DOCS: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.SMTP_URL && !env.ALLOW_LOG_MAILER) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'SMTP_URL is required in production',
      });
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
