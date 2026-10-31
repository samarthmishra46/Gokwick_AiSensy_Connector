import { z } from "zod";
import { normalizePhone } from "./phone";

export const TEMPLATE_PARAM_KEYS = [
  "first_name",
  "recovery_url",
  "cart_total",
  "items_summary",
  "store_name",
] as const;
export type TemplateParamKey = (typeof TEMPLATE_PARAM_KEYS)[number];

export const BUTTON_SUFFIX_SOURCES = ["recovery_url_path"] as const;
export type ButtonSuffixSource = (typeof BUTTON_SUFFIX_SOURCES)[number];

export interface Config {
  gokwikWebhookToken?: string;
  aisensyApiKey?: string;
  aisensyCampaignName?: string;
  aisensyApiUrl: string;
  templateParams: TemplateParamKey[];
  buttonUrlSuffixFrom?: ButtonSuffixSource;
  fallbackName: string;
  storeName: string;
  storeUrl: string;
  defaultCountryCode: string;
  dryRun: boolean;
  discoveryMode: boolean;
  adminToken?: string;
  testPhone?: string;
  redis?: { url: string; token: string };
  dedupeTtlSeconds: number;
  map: { phone?: string; name?: string; link?: string; cartId?: string; total?: string };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const ENV_VARS = [
  "GOKWIK_WEBHOOK_TOKEN",
  "AISENSY_API_KEY",
  "AISENSY_CAMPAIGN_NAME",
  "AISENSY_API_URL",
  "AISENSY_TEMPLATE_PARAMS",
  "AISENSY_BUTTON_URL_SUFFIX_FROM",
  "FALLBACK_NAME",
  "STORE_NAME",
  "STORE_URL",
  "DEFAULT_COUNTRY_CODE",
  "DRY_RUN",
  "DISCOVERY_MODE",
  "ADMIN_TOKEN",
  "TEST_PHONE",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  // Names used by Vercel's Upstash/KV marketplace integration, accepted as aliases.
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "DEDUPE_TTL_SECONDS",
  "MAP_PHONE",
  "MAP_NAME",
  "MAP_LINK",
  "MAP_CART_ID",
  "MAP_TOTAL",
] as const;

const secretToken = z
  .string()
  .min(16, "must be at least 16 characters")
  .regex(/^[A-Za-z0-9._~-]+$/, "may only contain letters, digits and . _ ~ - (it goes in a URL)");

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return fallback;
      const s = v.toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return true;
      if (["false", "0", "no", "off"].includes(s)) return false;
      ctx.addIssue({ code: "custom", message: 'must be "true" or "false"' });
      return z.NEVER;
    });

const schema = z.object({
  GOKWIK_WEBHOOK_TOKEN: secretToken.optional(),
  AISENSY_API_KEY: z.string().optional(),
  AISENSY_CAMPAIGN_NAME: z.string().optional(),
  AISENSY_API_URL: z
    .url({ protocol: /^https?$/ })
    .default("https://backend.aisensy.com/campaign/t1/api/v2"),
  AISENSY_TEMPLATE_PARAMS: z
    .string()
    .default("first_name,recovery_url")
    .transform((v, ctx) => {
      const keys = v
        .split(",")
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      const bad = keys.filter((k) => !(TEMPLATE_PARAM_KEYS as readonly string[]).includes(k));
      if (bad.length) {
        ctx.addIssue({
          code: "custom",
          message: `unknown key(s) ${bad.join(", ")}; allowed: ${TEMPLATE_PARAM_KEYS.join(", ")}`,
        });
        return z.NEVER;
      }
      return keys as TemplateParamKey[];
    }),
  AISENSY_BUTTON_URL_SUFFIX_FROM: z.enum(BUTTON_SUFFIX_SOURCES).optional(),
  FALLBACK_NAME: z.string().default("there"),
  STORE_NAME: z.string().default("THE MISSTT"),
  STORE_URL: z.url({ protocol: /^https?$/ }).default("https://www.themisstt.com"),
  DEFAULT_COUNTRY_CODE: z
    .string()
    .regex(/^\d{1,3}$/, "must be 1-3 digits, without +")
    .default("91"),
  DRY_RUN: bool(true),
  DISCOVERY_MODE: bool(true),
  ADMIN_TOKEN: secretToken.optional(),
  TEST_PHONE: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.url({ protocol: /^https$/ }).optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  KV_REST_API_URL: z.url({ protocol: /^https$/ }).optional(),
  KV_REST_API_TOKEN: z.string().optional(),
  DEDUPE_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(172_800),
  MAP_PHONE: z.string().optional(),
  MAP_NAME: z.string().optional(),
  MAP_LINK: z.string().optional(),
  MAP_CART_ID: z.string().optional(),
  MAP_TOTAL: z.string().optional(),
});

/** Read and validate env vars. Throws ConfigError (variable names only, never values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty strings count as "not set" so `FOO=` in Vercel/.env behaves like a missing var.
  const raw: Record<string, string | undefined> = {};
  for (const name of ENV_VARS) {
    const v = env[name]?.trim();
    raw[name] = v ? v : undefined;
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`),
    );
  }
  const e = parsed.data;

  const redisUrl = e.UPSTASH_REDIS_REST_URL ?? e.KV_REST_API_URL;
  const redisToken = e.UPSTASH_REDIS_REST_TOKEN ?? e.KV_REST_API_TOKEN;
  if (Boolean(redisUrl) !== Boolean(redisToken)) {
    throw new ConfigError([
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together (or both left empty)",
    ]);
  }

  return {
    gokwikWebhookToken: e.GOKWIK_WEBHOOK_TOKEN,
    aisensyApiKey: e.AISENSY_API_KEY,
    aisensyCampaignName: e.AISENSY_CAMPAIGN_NAME,
    aisensyApiUrl: e.AISENSY_API_URL,
    templateParams: e.AISENSY_TEMPLATE_PARAMS,
    buttonUrlSuffixFrom: e.AISENSY_BUTTON_URL_SUFFIX_FROM,
    fallbackName: e.FALLBACK_NAME,
    storeName: e.STORE_NAME,
    storeUrl: e.STORE_URL,
    defaultCountryCode: e.DEFAULT_COUNTRY_CODE,
    dryRun: e.DRY_RUN,
    discoveryMode: e.DISCOVERY_MODE,
    adminToken: e.ADMIN_TOKEN,
    testPhone: e.TEST_PHONE,
    redis: redisUrl && redisToken ? { url: redisUrl, token: redisToken } : undefined,
    dedupeTtlSeconds: e.DEDUPE_TTL_SECONDS,
    map: {
      phone: e.MAP_PHONE,
      name: e.MAP_NAME,
      link: e.MAP_LINK,
      cartId: e.MAP_CART_ID,
      total: e.MAP_TOTAL,
    },
  };
}

function sendProblems(cfg: Config): string[] {
  const problems: string[] = [];
  if (!cfg.aisensyApiKey) problems.push("AISENSY_API_KEY is required when DRY_RUN=false");
  if (!cfg.aisensyCampaignName) {
    problems.push("AISENSY_CAMPAIGN_NAME is required when DRY_RUN=false");
  }
  return problems;
}

/** Throws ConfigError if the webhook endpoint can't run with this config. */
export function assertWebhookConfig(cfg: Config): void {
  const problems: string[] = [];
  if (!cfg.gokwikWebhookToken) problems.push("GOKWIK_WEBHOOK_TOKEN is required");
  if (!cfg.dryRun && !cfg.discoveryMode) problems.push(...sendProblems(cfg));
  if (problems.length) throw new ConfigError(problems);
}

/** Throws ConfigError if /api/test-send can't run with this config. */
export function assertTestSendConfig(cfg: Config): void {
  const problems: string[] = [];
  if (!cfg.adminToken) problems.push("ADMIN_TOKEN is required");
  if (!cfg.testPhone) problems.push("TEST_PHONE is required");
  else if (!normalizePhone(cfg.testPhone, cfg.defaultCountryCode).ok) {
    problems.push("TEST_PHONE is not a valid phone number");
  }
  if (!cfg.dryRun) problems.push(...sendProblems(cfg));
  if (problems.length) throw new ConfigError(problems);
}
