/**
 * POST /api/shopify/order-created
 *
 * Shopify "Order creation" webhook (signed with SHOPIFY_WEBHOOK_SECRET). GoKwik checkout
 * orders still land in Shopify as normal orders, so this is where we learn that a shopper
 * completed their purchase. Each phone on the order is remembered (as a one-way hash) for
 * ORDER_SUPPRESS_SECONDS; abandoned carts from that phone are then skipped with
 * reason "order_completed".
 */
import { ConfigError, loadConfig } from "../../src/config";
import { handleError, json, shopifyHmacValid } from "../../src/http";
import { log } from "../../src/log";
import { maskPhone, normalizePhone } from "../../src/phone";
import { getStore } from "../../src/store";

/** Documented Shopify order fields that can hold the customer's phone. */
const PHONE_PATHS: readonly (readonly string[])[] = [
  ["phone"],
  ["customer", "phone"],
  ["billing_address", "phone"],
  ["shipping_address", "phone"],
  ["customer", "default_address", "phone"],
];

function at(o: unknown, path: readonly string[]): unknown {
  let cur = o;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function orderPhones(order: unknown, countryCode: string): string[] {
  const found = new Set<string>();
  for (const p of PHONE_PATHS) {
    const r = normalizePhone(at(order, p), countryCode);
    if (r.ok) found.add(r.digits);
  }
  return [...found];
}

export async function POST(request: Request): Promise<Response> {
  try {
    const cfg = loadConfig();
    if (!cfg.shopifyWebhookSecret) {
      throw new ConfigError(["SHOPIFY_WEBHOOK_SECRET is required for /api/shopify/order-created"]);
    }

    const raw = Buffer.from(await request.arrayBuffer());
    const hmac = request.headers.get("x-shopify-hmac-sha256");
    if (!shopifyHmacValid(raw, hmac, cfg.shopifyWebhookSecret)) {
      log.warn("shopify_bad_signature");
      return json({ error: "unauthorized" }, 401);
    }

    let order: unknown;
    try {
      order = JSON.parse(raw.toString("utf8"));
    } catch {
      return json({ error: "body is not valid JSON" }, 400);
    }

    const topic = request.headers.get("x-shopify-topic") ?? "(none)";
    const orderId = at(order, ["id"]);
    const phones = orderPhones(order, cfg.defaultCountryCode);
    const store = getStore(cfg);

    if (store.mode === "off") {
      log.warn("order_check_off", {
        topic,
        orderId,
        hint: "Needs Upstash Redis to remember orders",
      });
      return json({ ok: true, recorded: 0, store: "off" });
    }

    // Errors here return 500, so Shopify retries the webhook.
    for (const p of phones) await store.markOrdered(p);
    log.info("order_recorded", {
      topic,
      orderId,
      phones: phones.map((p) => maskPhone(p, cfg.defaultCountryCode)),
    });
    if (!phones.length) log.warn("order_without_phone", { topic, orderId });
    return json({ ok: true, recorded: phones.length });
  } catch (err) {
    return handleError(err, "shopify/order-created");
  }
}
