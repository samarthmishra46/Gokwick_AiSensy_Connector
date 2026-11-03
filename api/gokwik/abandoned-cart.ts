/**
 * POST /api/gokwik/abandoned-cart?token=<GOKWIK_WEBHOOK_TOKEN>
 *
 * Receives GoKwik abandoned-cart webhooks and sends each cart to an AiSensy API
 * campaign (see src/deliver.ts for the per-cart steps). Returns 500 only when a retry
 * could help (AiSensy network/5xx/429/auth, Redis down), so GoKwik may retry; failed
 * sends are also kept in the Redis retry queue for /api/cron/retry-failed. Dedupe keeps
 * any retry from messaging the same cart twice.
 */
import { assertWebhookConfig, loadConfig, type Config } from "../../src/config";
import { deliver, type Mode, type Outcome, type Status } from "../../src/deliver";
import { logDiscovery } from "../../src/discovery";
import { extractFields, splitCarts, type CartEntry, type Extraction } from "../../src/extract";
import { handleError, json, readBody, tokenMatches, unauthorized } from "../../src/http";
import { log } from "../../src/log";
import { maskPhone, normalizePhone } from "../../src/phone";
import { dedupeId, getStore, type Store } from "../../src/store";

/** Stay inside Vercel's 10 s maxDuration. */
const BUDGET_MS = 9_000;
const CONCURRENCY = 5;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Which path each field came from (no values), for the per-cart log line. */
function pathsOf(ex: Extraction): Record<string, string> {
  return Object.fromEntries(Object.entries(ex).map(([k, p]) => [k, `${p.path} (${p.via})`]));
}

type Result = Pick<Outcome, "status" | "reason">;

async function processCart(
  cfg: Config,
  mode: Mode,
  entry: CartEntry,
  cartIndex: number,
  store: Store | undefined,
  deadline: number,
): Promise<Result> {
  const cc = cfg.defaultCountryCode;
  const ex = extractFields(entry.cart, cfg.map);
  const phone = ex.phone ? normalizePhone(ex.phone.value, cc) : undefined;

  if (mode === "discovery") {
    logDiscovery({
      cartIndex,
      at: entry.at,
      cart: entry.cart,
      extraction: ex,
      phoneValid: phone?.ok ?? false,
      countryCode: cc,
    });
    return { status: "skipped", reason: "discovery_mode" };
  }

  const ctx = { cartIndex, at: entry.at, cartId: ex.cartId?.value, paths: pathsOf(ex) };
  const done = (status: Status, reason: string, extra: Record<string, unknown> = {}): Result => {
    const fields = { ...ctx, status, reason, ...extra };
    if (status === "failed" || status === "rejected") log.error("cart_result", fields);
    else if (status === "skipped") log.warn("cart_result", fields);
    else log.info("cart_result", fields);
    return { status, reason };
  };

  // Only when configured (MAP_EVENT_TYPE + ALLOWED_EVENT_TYPES): is this an abandoned cart?
  if (cfg.allowedEventTypes.length) {
    const type = ex.eventType?.value.toLowerCase();
    if (!type || !cfg.allowedEventTypes.includes(type)) {
      return done("skipped", "not_abandoned_event", { eventType: type ?? "(missing)" });
    }
  }

  if (!ex.phone || !phone) return done("skipped", "missing_phone");
  if (!phone.ok) {
    return done("skipped", "invalid_phone", {
      phone: maskPhone(ex.phone.value, cc),
      detail: phone.reason,
    });
  }

  let link = ex.link?.value;
  if (!link) {
    if (cfg.requireRecoveryLink) {
      return done("skipped", "missing_recovery_link", { phone: maskPhone(phone.digits, cc) });
    }
    log.warn("no_recovery_link", { ...ctx, fallback: "STORE_URL" });
    link = cfg.storeUrl;
  }

  const outcome = await deliver(
    cfg,
    mode,
    store!,
    {
      recipient: {
        phone: phone.digits,
        firstName: ex.firstName?.value,
        recoveryUrl: link,
        cartTotal: ex.total?.value,
        itemsSummary: ex.itemsSummary?.value,
      },
      id: dedupeId(ex.cartId?.value, phone.digits, link),
      cartId: ex.cartId?.value,
      attempts: 0,
      firstSeenAt: Date.now(),
    },
    deadline,
  );
  return done(outcome.status, outcome.reason, {
    ...outcome.extra,
    ...(outcome.queued !== undefined && { queuedForRetry: outcome.queued }),
  });
}

export async function POST(request: Request): Promise<Response> {
  const deadline = Date.now() + BUDGET_MS;
  try {
    const cfg = loadConfig();
    assertWebhookConfig(cfg);
    if (!tokenMatches(request, cfg.gokwikWebhookToken)) return unauthorized();

    const contentType = request.headers.get("content-type") ?? "(none)";
    const parsed = await readBody(request);
    if (!parsed.ok) {
      log.warn("bad_body", { reason: parsed.reason, contentType });
      return json({ error: parsed.reason }, 400);
    }

    const mode: Mode = cfg.discoveryMode ? "discovery" : cfg.dryRun ? "dry_run" : "live";
    const carts = splitCarts(parsed.body);
    log.info("webhook_received", { mode, carts: carts.length, contentType });
    if (!carts.length) log.warn("no_carts_in_body", { contentType });

    const store = mode === "discovery" ? undefined : getStore(cfg);
    const outcomes = await mapLimit(carts, CONCURRENCY, (entry, i) =>
      processCart(cfg, mode, entry, i, store, deadline),
    );

    const count = (s: Status) => outcomes.filter((o) => o.status === s).length;
    const summary = {
      received: carts.length,
      sent: count("sent"),
      skipped: count("skipped"),
      rejected: count("rejected"),
      failed: count("failed"),
      mode,
    };
    log.info("webhook_done", summary);
    return json(summary, summary.failed > 0 ? 500 : 200);
  } catch (err) {
    return handleError(err, "gokwik/abandoned-cart");
  }
}

/** Lets you (or GoKwik, if it pings the URL on save) check the URL and token in a browser. */
export async function GET(request: Request): Promise<Response> {
  try {
    const cfg = loadConfig();
    assertWebhookConfig(cfg);
    if (!tokenMatches(request, cfg.gokwikWebhookToken)) return unauthorized();
    return json({ ok: true, hint: "GoKwik should POST abandoned carts to this URL." });
  } catch (err) {
    return handleError(err, "gokwik/abandoned-cart");
  }
}
