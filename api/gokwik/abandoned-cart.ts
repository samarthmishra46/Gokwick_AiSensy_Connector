/**
 * POST /api/gokwik/abandoned-cart?token=<GOKWIK_WEBHOOK_TOKEN>
 *
 * Receives GoKwik abandoned-cart webhooks and sends each cart to an AiSensy API
 * campaign. Returns 500 only when a retry could help (AiSensy network/5xx/429), so
 * GoKwik retries; dedupe keeps a retry from messaging the same cart twice.
 */
import { BuildError, buildBody, logDryRun, sendToAiSensy } from "../../src/aisensy";
import { assertWebhookConfig, loadConfig, type Config } from "../../src/config";
import { dedupeKey, getDeduper, type Deduper } from "../../src/dedupe";
import { logDiscovery } from "../../src/discovery";
import { extractFields, splitCarts, type CartEntry, type Extraction } from "../../src/extract";
import { handleError, json, readBody, tokenMatches, unauthorized } from "../../src/http";
import { log } from "../../src/log";
import { maskPhone, normalizePhone } from "../../src/phone";

/** Stay inside Vercel's 10 s maxDuration. */
const BUDGET_MS = 9_000;
/** Don't start a new AiSensy call with less time than this left; let GoKwik retry instead. */
const MIN_SEND_WINDOW_MS = 1_500;
const AISENSY_TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;

type Mode = "discovery" | "dry_run" | "live";
type Status = "sent" | "skipped" | "failed";
interface Outcome {
  status: Status;
  reason: string;
}

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

async function processCart(
  cfg: Config,
  mode: Mode,
  entry: CartEntry,
  cartIndex: number,
  deduper: Deduper | undefined,
  deadline: number,
): Promise<Outcome> {
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
  const done = (status: Status, reason: string, extra: Record<string, unknown> = {}): Outcome => {
    const fields = { ...ctx, status, reason, ...extra };
    if (status === "failed") log.error("cart_result", fields);
    else if (status === "skipped") log.warn("cart_result", fields);
    else log.info("cart_result", fields);
    return { status, reason };
  };

  if (!ex.phone || !phone) return done("skipped", "missing_phone");
  if (!phone.ok) {
    return done("skipped", "invalid_phone", {
      phone: maskPhone(ex.phone.value, cc),
      detail: phone.reason,
    });
  }
  const maskedPhone = maskPhone(phone.digits, cc);

  let link = ex.link?.value;
  if (!link) {
    log.warn("no_recovery_link", { ...ctx, fallback: "STORE_URL" });
    link = cfg.storeUrl;
  }

  let body;
  try {
    body = buildBody(cfg, {
      phone: phone.digits,
      firstName: ex.firstName?.value,
      recoveryUrl: link,
      cartTotal: ex.total?.value,
      itemsSummary: ex.itemsSummary?.value,
    });
  } catch (err) {
    if (err instanceof BuildError) {
      return done("skipped", "cannot_build_message", { phone: maskedPhone, detail: err.message });
    }
    throw err;
  }

  if (mode === "dry_run") {
    logDryRun(cfg, body, { cartIndex });
    return done("sent", "dry_run", { phone: maskedPhone });
  }

  if (deadline - Date.now() < MIN_SEND_WINDOW_MS) {
    return done("failed", "deferred_time_budget", { phone: maskedPhone });
  }

  const key = dedupeKey(ex.cartId?.value, phone.digits, link);
  let claimed: boolean;
  try {
    claimed = await deduper!.claim(key);
  } catch (err) {
    return done("failed", "dedupe_error", {
      phone: maskedPhone,
      detail: err instanceof Error ? err.message : "unknown",
    });
  }
  if (!claimed) return done("skipped", "duplicate", { phone: maskedPhone });

  const timeout = Math.min(AISENSY_TIMEOUT_MS, deadline - Date.now() - 500);
  const res = await sendToAiSensy(cfg, body, timeout);
  if (res.ok) return done("sent", "aisensy_ok", { phone: maskedPhone, httpStatus: res.status });

  const extra = { phone: maskedPhone, httpStatus: res.status, detail: res.reason };
  if (res.kind === "transient") {
    try {
      await deduper!.release(key);
    } catch (err) {
      log.error("dedupe_release_failed", {
        ...ctx,
        detail: err instanceof Error ? err.message : "unknown",
      });
    }
    return done("failed", "aisensy_transient_error", extra);
  }
  return done("skipped", "aisensy_rejected", extra);
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

    const deduper = mode === "live" ? getDeduper(cfg) : undefined;
    const outcomes = await mapLimit(carts, CONCURRENCY, (entry, i) =>
      processCart(cfg, mode, entry, i, deduper, deadline),
    );

    const count = (s: Status) => outcomes.filter((o) => o.status === s).length;
    const summary = {
      received: carts.length,
      sent: count("sent"),
      skipped: count("skipped"),
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
