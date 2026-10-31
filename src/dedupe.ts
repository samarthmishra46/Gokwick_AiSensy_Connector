import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Config } from "./config";
import { log } from "./log";

export interface Deduper {
  mode: "redis" | "off";
  /** true = first time we've seen this key (go ahead and send); false = duplicate. */
  claim(key: string): Promise<boolean>;
  /** Forget a key so a retry can send (used after a transient AiSensy failure). */
  release(key: string): Promise<void>;
}

export function dedupeKey(cartId: string | undefined, phone: string, link: string): string {
  const id =
    cartId ??
    createHash("sha256")
      .update(phone + link)
      .digest("hex");
  return `gk:ac:${id}`;
}

const off: Deduper = {
  mode: "off",
  claim: async () => true,
  release: async () => {},
};

let warnedOff = false;
let cached: { url: string; token: string; deduper: Deduper } | undefined;

export function getDeduper(cfg: Config): Deduper {
  if (!cfg.redis) {
    if (!warnedOff) {
      warnedOff = true;
      log.warn("dedupe_off", {
        hint: "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN so GoKwik retries can't send twice",
      });
    }
    return off;
  }

  const { url, token } = cfg.redis;
  if (cached && cached.url === url && cached.token === token) return cached.deduper;

  // Keep retries short: the whole request has a ~10 s budget.
  const redis = new Redis({ url, token, retry: { retries: 1, backoff: () => 200 } });
  const ttl = cfg.dedupeTtlSeconds;
  const deduper: Deduper = {
    mode: "redis",
    async claim(key) {
      const res = await redis.set(key, "1", { nx: true, ex: ttl });
      return res === "OK";
    },
    async release(key) {
      await redis.del(key);
    },
  };
  cached = { url, token, deduper };
  return deduper;
}
