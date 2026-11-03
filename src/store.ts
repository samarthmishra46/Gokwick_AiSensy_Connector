/**
 * Everything the connector remembers, in Upstash Redis. Without Redis every method is a
 * harmless no-op ("off" mode) and the connector still works, just without duplicate
 * protection, the "already ordered" check, or the retry queue.
 *
 * Keys (all expire):
 *   gk:ac:<id>          "already sent" marker per cart (dedupe), DEDUPE_TTL_SECONDS
 *   gk:ord:<sha256>     a Shopify order was placed from this phone, ORDER_SUPPRESS_SECONDS
 *   gk:retry:due        sorted set: cart id -> time of its next retry (ms)
 *   gk:retry:item:<id>  what's needed to resend (phone, first name, link), RETRY_WINDOW_SECONDS
 *   gk:status:<id>      last processing result (no personal data), DEDUPE_TTL_SECONDS
 */
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Recipient } from "./aisensy";
import type { Config } from "./config";
import { log } from "./log";

/** Carts older than this aren't worth recovering any more; the retry queue drops them. */
export const RETRY_WINDOW_SECONDS = 86_400;

const DUE_KEY = "gk:retry:due";
const acKey = (id: string) => `gk:ac:${id}`;
const itemKey = (id: string) => `gk:retry:item:${id}`;
const statusKey = (id: string) => `gk:status:${id}`;
const orderKey = (phoneDigits: string) => `gk:ord:${sha256(phoneDigits)}`;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface RetryItem {
  /** Dedupe id of the cart (cart id, or a hash of phone + link). */
  id: string;
  recipient: Recipient;
  /** AiSensy calls made so far. */
  attempts: number;
  /** When the webhook first arrived (ms since epoch). */
  firstSeenAt: number;
  lastReason: string;
  cartId?: string;
}

export interface StatusRecord {
  status: string;
  reason: string;
  httpStatus?: number;
  attempts: number;
  at: string;
}

export interface Store {
  mode: "redis" | "off";
  /** true = first time we've seen this cart (go ahead and send); false = duplicate. */
  claim(id: string): Promise<boolean>;
  /** Forget a cart so a retry can send (after a temporary AiSensy failure). */
  release(id: string): Promise<void>;
  markOrdered(phoneDigits: string): Promise<boolean>;
  hasOrdered(phoneDigits: string): Promise<boolean>;
  /** Save (or update) a failed send for /api/cron/retry-failed. false = not stored. */
  enqueueRetry(item: RetryItem, dueAt: number): Promise<boolean>;
  dueRetries(now: number, limit: number): Promise<RetryItem[]>;
  removeRetry(id: string): Promise<void>;
  setStatus(id: string, record: StatusRecord): Promise<void>;
}

/** Stable id for a cart: GoKwik's cart id, or a one-way hash of phone + link. */
export function dedupeId(cartId: string | undefined, phone: string, link: string): string {
  return cartId ?? sha256(phone + link);
}

const off: Store = {
  mode: "off",
  claim: async () => true,
  release: async () => {},
  markOrdered: async () => false,
  hasOrdered: async () => false,
  enqueueRetry: async () => false,
  dueRetries: async () => [],
  removeRetry: async () => {},
  setStatus: async () => {},
};

let warnedOff = false;
let cached: { url: string; token: string; store: Store } | undefined;

export function getStore(cfg: Config): Store {
  if (!cfg.redis) {
    if (!warnedOff) {
      warnedOff = true;
      log.warn("store_off", {
        hint: "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for duplicate protection, the already-ordered check and retries",
      });
    }
    return off;
  }

  const { url, token } = cfg.redis;
  if (cached && cached.url === url && cached.token === token) return cached.store;

  // Keep retries short: the whole request has a ~10 s budget.
  const redis = new Redis({ url, token, retry: { retries: 1, backoff: () => 200 } });
  const store: Store = {
    mode: "redis",
    async claim(id) {
      const res = await redis.set(acKey(id), "1", { nx: true, ex: cfg.dedupeTtlSeconds });
      return res === "OK";
    },
    async release(id) {
      await redis.del(acKey(id));
    },
    async markOrdered(phoneDigits) {
      await redis.set(orderKey(phoneDigits), "1", { ex: cfg.orderSuppressSeconds });
      return true;
    },
    async hasOrdered(phoneDigits) {
      return (await redis.exists(orderKey(phoneDigits))) > 0;
    },
    async enqueueRetry(item, dueAt) {
      await redis.set(itemKey(item.id), item, { ex: RETRY_WINDOW_SECONDS });
      await redis.zadd(DUE_KEY, { score: dueAt, member: item.id });
      return true;
    },
    async dueRetries(now, limit) {
      const ids = await redis.zrange<string[]>(DUE_KEY, 0, now, {
        byScore: true,
        offset: 0,
        count: limit,
      });
      const items: RetryItem[] = [];
      for (const id of ids) {
        const item = await redis.get<RetryItem>(itemKey(id));
        if (item) items.push(item);
        else await redis.zrem(DUE_KEY, id); // item expired
      }
      return items;
    },
    async removeRetry(id) {
      await redis.zrem(DUE_KEY, id);
      await redis.del(itemKey(id));
    },
    async setStatus(id, record) {
      await redis.set(statusKey(id), record, { ex: cfg.dedupeTtlSeconds });
    },
  };
  cached = { url, token, store };
  return store;
}
