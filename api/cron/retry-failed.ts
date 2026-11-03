/**
 * GET /api/cron/retry-failed
 *
 * Resends carts whose AiSensy call failed temporarily (network, 429, 5xx, timeout,
 * time budget) or with an auth error (401/403, e.g. after the API key is fixed).
 * Each retry re-checks dedupe and the "already ordered" marker, and is rebuilt from the
 * current config, so fixing AISENSY_API_KEY / AISENSY_CAMPAIGN_NAME applies to queued carts.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this automatically
 * when CRON_SECRET is set), or `?token=<ADMIN_TOKEN>` to trigger it by hand.
 */
import { assertWebhookConfig, loadConfig } from "../../src/config";
import { deliver, type Status } from "../../src/deliver";
import { bearerMatches, handleError, json, tokenMatches, unauthorized } from "../../src/http";
import { log } from "../../src/log";
import { getStore } from "../../src/store";

const BUDGET_MS = 9_000;
/** Don't start another cart with less time than this left. */
const MIN_ITEM_WINDOW_MS = 2_000;
const BATCH = 20;

async function run(request: Request): Promise<Response> {
  const deadline = Date.now() + BUDGET_MS;
  try {
    const cfg = loadConfig();
    if (!bearerMatches(request, cfg.cronSecret) && !tokenMatches(request, cfg.adminToken)) {
      return unauthorized();
    }
    assertWebhookConfig(cfg);

    if (cfg.discoveryMode || cfg.dryRun) {
      return json({ ok: true, mode: cfg.discoveryMode ? "discovery" : "dry_run", processed: 0 });
    }
    const store = getStore(cfg);
    if (store.mode === "off") return json({ ok: true, queue: "off", processed: 0 });

    const items = await store.dueRetries(Date.now(), BATCH);
    const counts: Record<Status, number> = { sent: 0, skipped: 0, rejected: 0, failed: 0 };
    let processed = 0;
    for (const item of items) {
      if (deadline - Date.now() < MIN_ITEM_WINDOW_MS) break;
      processed++;
      const outcome = await deliver(cfg, "live", store, item, deadline);
      counts[outcome.status]++;
      // deliver() re-queues (overwrites) the item on a retryable AiSensy failure and sets
      // queued=false when it gives up. A Redis error (queued undefined) leaves the item due,
      // so the next run tries again. Anything else is finished.
      const keep =
        outcome.queued === true || (outcome.status === "failed" && outcome.queued === undefined);
      if (!keep) await store.removeRetry(item.id);
      const fields = {
        cartId: item.cartId,
        previousReason: item.lastReason,
        status: outcome.status,
        reason: outcome.reason,
        requeued: outcome.queued ?? false,
        ...outcome.extra,
      };
      if (outcome.status === "failed" || outcome.status === "rejected") {
        log.error("retry_result", fields);
      } else log.info("retry_result", fields);
    }

    const summary = { ok: true, due: items.length, processed, ...counts };
    log.info("retry_done", summary);
    return json(summary);
  } catch (err) {
    return handleError(err, "cron/retry-failed");
  }
}

export const GET = run;
export const POST = run;
