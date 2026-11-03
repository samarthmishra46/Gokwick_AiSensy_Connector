/**
 * Send one recovery message: already-ordered check -> build -> dedupe claim -> AiSensy ->
 * record the result -> queue a retry on failures that a retry can fix.
 * Used by the GoKwik webhook and by /api/cron/retry-failed.
 */
import { BuildError, buildBody, logDryRun, sendToAiSensy, type Recipient } from "./aisensy";
import type { Config } from "./config";
import { log } from "./log";
import { maskPhone } from "./phone";
import { RETRY_WINDOW_SECONDS, type RetryItem, type Store } from "./store";

export type Mode = "discovery" | "dry_run" | "live";
/** rejected = AiSensy refused it for good (logged as an error; GoKwik still gets 200). */
export type Status = "sent" | "skipped" | "rejected" | "failed";

export interface Outcome {
  status: Status;
  reason: string;
  /** true when the cart sits in the retry queue for /api/cron/retry-failed. */
  queued?: boolean;
  extra: Record<string, unknown>;
}

const MIN_SEND_WINDOW_MS = 1_500;
const AISENSY_TIMEOUT_MS = 8_000;
const RETRY_BASE_DELAY_MS = 5 * 60_000;
const RETRY_MAX_DELAY_MS = 2 * 60 * 60_000;

export interface Delivery {
  recipient: Recipient;
  /** Dedupe id (see dedupeId). */
  id: string;
  cartId?: string;
  /** AiSensy calls already made for this cart (0 for a fresh webhook). */
  attempts: number;
  firstSeenAt: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown";
}

export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_DELAY_MS);
}

export async function deliver(
  cfg: Config,
  mode: Exclude<Mode, "discovery">,
  store: Store,
  d: Delivery,
  deadline: number,
): Promise<Outcome> {
  const r = d.recipient;
  const phone = maskPhone(r.phone, cfg.defaultCountryCode);
  const out = (status: Status, reason: string, extra: Record<string, unknown> = {}): Outcome => ({
    status,
    reason,
    extra: { phone, ...extra },
  });

  // 1. Customer already completed an order (recorded by /api/shopify/order-created)?
  try {
    if (await store.hasOrdered(r.phone)) {
      await safeStatus(store, d, "skipped", "order_completed");
      return out("skipped", "order_completed");
    }
  } catch (err) {
    return out("failed", "store_error", { detail: errText(err) });
  }

  // 2. Build the AiSensy request.
  let body;
  try {
    body = buildBody(cfg, r);
  } catch (err) {
    if (err instanceof BuildError)
      return out("skipped", "cannot_build_message", { detail: err.message });
    throw err;
  }

  if (mode === "dry_run") {
    logDryRun(cfg, body, { cartId: d.cartId });
    return out("sent", "dry_run");
  }

  // 3. Not enough time left in this request: queue it instead of risking a cut-off send.
  if (deadline - Date.now() < MIN_SEND_WINDOW_MS) {
    const queued = await queueRetry(cfg, store, d, "deferred_time_budget", false);
    return { ...out("failed", "deferred_time_budget"), queued };
  }

  // 4. Dedupe: only one request ever sends a given cart.
  let claimed: boolean;
  try {
    claimed = await store.claim(d.id);
  } catch (err) {
    return out("failed", "dedupe_error", { detail: errText(err) });
  }
  if (!claimed) return out("skipped", "duplicate");

  // 5. Send.
  const attempts = d.attempts + 1;
  const timeout = Math.min(AISENSY_TIMEOUT_MS, deadline - Date.now() - 500);
  const res = await sendToAiSensy(cfg, body, timeout);
  if (res.ok) {
    await safeStatus(store, d, "sent", "aisensy_ok", res.status, attempts);
    return out("sent", "aisensy_ok", {
      httpStatus: res.status,
      aisensyResponse: res.response,
      attempts,
    });
  }

  const extra = { httpStatus: res.status, detail: res.reason, attempts };
  if (res.kind === "permanent") {
    await safeStatus(store, d, "rejected", "aisensy_rejected", res.status, attempts);
    return out("rejected", "aisensy_rejected", extra);
  }

  // transient or auth: free the cart so a retry (GoKwik's or ours) can send it.
  try {
    await store.release(d.id);
  } catch (err) {
    log.error("dedupe_release_failed", { cartId: d.cartId, detail: errText(err) });
  }
  const reason = res.kind === "auth" ? "aisensy_auth_error" : "aisensy_transient_error";
  const queued = await queueRetry(cfg, store, { ...d, attempts }, reason, true);
  await safeStatus(store, d, "failed", reason, res.status, attempts);
  return { ...out("failed", reason, extra), queued };
}

async function safeStatus(
  store: Store,
  d: Delivery,
  status: string,
  reason: string,
  httpStatus?: number,
  attempts = d.attempts,
): Promise<void> {
  try {
    await store.setStatus(d.id, {
      status,
      reason,
      httpStatus,
      attempts,
      at: new Date().toISOString(),
    });
  } catch (err) {
    log.warn("status_record_failed", { cartId: d.cartId, detail: errText(err) });
  }
}

/** Put a failed cart in the retry queue, unless it has used up its attempts or is too old. */
async function queueRetry(
  cfg: Config,
  store: Store,
  d: Delivery,
  reason: string,
  afterAttempt: boolean,
): Promise<boolean> {
  const tooOld = Date.now() - d.firstSeenAt > RETRY_WINDOW_SECONDS * 1000;
  if (d.attempts >= cfg.retryMaxAttempts || tooOld) {
    log.error("retry_gave_up", {
      cartId: d.cartId,
      attempts: d.attempts,
      reason,
      why: tooOld ? "older_than_retry_window" : "max_attempts",
    });
    return false;
  }
  const item: RetryItem = {
    id: d.id,
    recipient: d.recipient,
    attempts: d.attempts,
    firstSeenAt: d.firstSeenAt,
    lastReason: reason,
    cartId: d.cartId,
  };
  const dueAt = Date.now() + (afterAttempt ? retryDelayMs(d.attempts) : 0);
  try {
    const stored = await store.enqueueRetry(item, dueAt);
    if (!stored) {
      log.warn("retry_not_queued", {
        cartId: d.cartId,
        hint: "Set UPSTASH_REDIS_REST_URL/TOKEN so failed sends are kept and retried",
      });
    }
    return stored;
  } catch (err) {
    log.error("retry_queue_failed", { cartId: d.cartId, detail: errText(err) });
    return false;
  }
}
