import { z } from 'zod';
import 'dotenv/config';

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  RPC_URL: z.string().url().optional(),
  HOT_WALLET_KEY: z.string().min(10).optional(),
  TOKEN_ADDRESS: z.string().min(10).optional(),
  TOKEN_DECIMALS: z.coerce.number().int().positive().default(8),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),
  WEBHOOK_SECRET: z.string().optional(),
  KMS_SIGNER_URL: z.string().optional(), // opcional para uso futuro
  PRICE_TTL_SEC: z.coerce.number().positive().default(60 * 5),
  RATE_LOCK_SEC: z.coerce.number().positive().default(600),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z.string().optional(),
  ORDER_MIN_BRL: z.coerce.number().positive().default(10),
  ORDER_MAX_BRL: z.coerce.number().positive().default(100000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().positive().default(100),
  ORDER_RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(60_000),
  ORDER_RATE_LIMIT_MAX: z.coerce.number().positive().default(20)
});

const env = EnvSchema.parse(process.env);

export const config = {
  rpcUrl: env.RPC_URL,
  hotWalletKey: env.HOT_WALLET_KEY,
  tokenAddress: env.TOKEN_ADDRESS,
  tokenDecimals: env.TOKEN_DECIMALS,
  allowedOrigins: env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
  webhookSecret: env.WEBHOOK_SECRET,
  kmsSignerUrl: env.KMS_SIGNER_URL,
  priceTtlSec: env.PRICE_TTL_SEC,
  rateLockSec: env.RATE_LOCK_SEC,
  databaseUrl: env.DATABASE_URL,
  orderMinBrl: env.ORDER_MIN_BRL,
  orderMaxBrl: env.ORDER_MAX_BRL,
  rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: env.RATE_LIMIT_MAX,
  orderRateLimitWindowMs: env.ORDER_RATE_LIMIT_WINDOW_MS,
  orderRateLimitMax: env.ORDER_RATE_LIMIT_MAX
};
