/**
 * End-to-end behaviour of the abandoned-cart workflow with AiSensy (fetch) and Upstash
 * (fakeRedis) mocked: completed orders, retries, credentials, payload shapes.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN, API_KEY, captureLogs, fakeCart, mockFetch, post, setEnv } from "./helpers";

vi.mock("@upstash/redis", () => import("./fakeRedis.js"));
import { redisControl, redisStore, resetRedis, zsets } from "./fakeRedis";

import { POST as webhook } from "../api/gokwik/abandoned-cart";
import { GET as retryCron } from "../api/cron/retry-failed";
import { POST as orderCreated } from "../api/shopify/order-created";
import { GET as health } from "../api/health";

const PATH = "/api/gokwik/abandoned-cart";
const SHOPIFY_SECRET = "fake-shopify-webhook-secret";
const CRON_SECRET = "fake-cron-secret-0123456789";

function sentBody(fetchFn: ReturnType<typeof mockFetch>, call = 0) {
  return JSON.parse(String(fetchFn.mock.calls[call]![1]!.body));
}

function logLines(logs: { lines: string[] }) {
  return logs.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function shopifyRequest(order: unknown, { secret = SHOPIFY_SECRET, topic = "orders/create" } = {}) {
  const raw = JSON.stringify(order);
  const hmac = createHmac("sha256", secret).update(raw).digest("base64");
  return new Request("https://connector.example.test/api/shopify/order-created", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-topic": topic,
    },
    body: raw,
  });
}

function cronRequest(auth: "bearer" | "admin" | "none" = "bearer") {
  const url = new URL("https://connector.example.test/api/cron/retry-failed");
  if (auth === "admin") url.searchParams.set("token", ADMIN_TOKEN);
  const headers: Record<string, string> = {};
  if (auth === "bearer") headers.authorization = `Bearer ${CRON_SECRET}`;
  return new Request(url, { headers });
}

const retryItemKey = (id: string) => `gk:retry:item:${id}`;
const due = () => [...(zsets.get("gk:retry:due")?.keys() ?? [])];

beforeEach(() => {
  resetRedis();
  setEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, CRON_SECRET });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("completed orders (Shopify order webhook)", () => {
  const order = {
    id: 5550001,
    phone: null,
    customer: { phone: "+919000000001" },
    shipping_address: { phone: "9000000001" },
    billing_address: { phone: "+91 90000 00042" },
  };

  it("records the order's phones (hashed) and then skips that shopper's abandoned cart", async () => {
    const logs = captureLogs();
    const fetchFn = mockFetch();

    const res = await orderCreated(shopifyRequest(order));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 2 });
    const orderKeys = [...redisStore.keys()].filter((k) => k.startsWith("gk:ord:"));
    expect(orderKeys).toHaveLength(2);
    expect(orderKeys.join()).not.toContain("9000000001"); // hashed, not raw

    const wh = await webhook(post(PATH, fakeCart()));
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ sent: 0, skipped: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logs.text()).toContain('"reason":"order_completed"');
    expect(logs.text()).not.toContain("9000000001");
  });

  it("does not suppress a different shopper", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    await orderCreated(shopifyRequest(order));
    await webhook(post(PATH, fakeCart({ phone: "9000000077" })));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("dry run also honours the order check (read-only)", async () => {
    setEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, DRY_RUN: "true" });
    const logs = captureLogs();
    await orderCreated(shopifyRequest(order));
    await webhook(post(PATH, fakeCart()));
    expect(logs.text()).toContain("order_completed");
    expect(logs.text()).not.toContain("dry_run_would_send");
  });

  it("rejects a bad Shopify signature with 401 and records nothing", async () => {
    captureLogs();
    const res = await orderCreated(shopifyRequest(order, { secret: "wrong-secret" }));
    expect(res.status).toBe(401);
    expect(redisStore.size).toBe(0);
  });

  it("500 when SHOPIFY_WEBHOOK_SECRET isn't set (Shopify will retry)", async () => {
    setEnv({ SHOPIFY_WEBHOOK_SECRET: "" });
    const logs = captureLogs();
    const res = await orderCreated(shopifyRequest(order));
    expect(res.status).toBe(500);
    expect(logs.text()).toContain("SHOPIFY_WEBHOOK_SECRET is required");
  });

  it("order without any phone -> 200, nothing recorded", async () => {
    const logs = captureLogs();
    const res = await orderCreated(shopifyRequest({ id: 1, email: "x@example.test" }));
    expect(await res.json()).toEqual({ ok: true, recorded: 0 });
    expect(logs.text()).toContain("order_without_phone");
  });

  it("without Redis: 200 and a warning (can't remember orders)", async () => {
    setEnv({
      SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET,
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
    });
    const logs = captureLogs();
    const res = await orderCreated(shopifyRequest(order));
    expect(await res.json()).toMatchObject({ recorded: 0, store: "off" });
    expect(logs.text()).toContain("order_check_off");
  });

  it("health reports orderCheck on when Redis and the Shopify secret are set", async () => {
    expect(await health().json()).toMatchObject({ orderCheck: "on", retryQueue: "redis" });
  });
});

describe("AiSensy responses", () => {
  it("records a successful send's status without personal data", async () => {
    const logs = captureLogs();
    mockFetch(200, '{"success":"true","submitted_message_id":"abc"}');
    await webhook(post(PATH, fakeCart()));
    expect(redisStore.get("gk:status:fake-cart-001")).toMatchObject({
      status: "sent",
      reason: "aisensy_ok",
      httpStatus: 200,
      attempts: 1,
    });
    expect(JSON.stringify(redisStore.get("gk:status:fake-cart-001"))).not.toContain("9000000001");
    const result = logLines(logs).find((l) => l.msg === "cart_result")!;
    expect(result).toMatchObject({ status: "sent", httpStatus: 200 });
    expect(String(result.aisensyResponse)).toContain("submitted_message_id");
  });

  it.each(['{"success":"false","message":"Campaign not live"}', '{"success":false}'])(
    "2xx whose body says it failed (%s) is NOT reported as sent",
    async (body) => {
      const logs = captureLogs();
      mockFetch(200, body);
      const res = await webhook(post(PATH, fakeCart()));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ sent: 0, rejected: 1 });
      expect(logs.text()).toContain("aisensy_rejected");
      expect(redisStore.get("gk:status:fake-cart-001")).toMatchObject({ status: "rejected" });
    },
  );

  it("invalid API key (401) -> 500, cart released and queued; fixed key + cron sends it", async () => {
    const logs = captureLogs();
    const fetchFn = mockFetch(401, '{"message":"Invalid API Key"}');
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ sent: 0, failed: 1 });
    expect(logs.text()).toContain("aisensy_auth_error");
    expect(redisStore.has("gk:ac:fake-cart-001")).toBe(false);
    expect(due()).toEqual(["fake-cart-001"]);
    expect(logs.text()).not.toContain(API_KEY);

    // Operator fixes the key; next cron run after the backoff sends with the new key.
    setEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, CRON_SECRET, AISENSY_API_KEY: "fixed-key" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    fetchFn.mockResolvedValue(new Response('{"success":"true"}', { status: 200 }));

    const cron = await retryCron(cronRequest());
    expect(await cron.json()).toMatchObject({ due: 1, processed: 1, sent: 1 });
    expect(sentBody(fetchFn, 1)).toMatchObject({
      apiKey: "fixed-key",
      destination: "+919000000001",
      templateParams: ["Testy", "https://checkout.example.test/recover/fake-cart-001?x=1"],
    });
    expect(due()).toEqual([]);
    expect(redisStore.has(retryItemKey("fake-cart-001"))).toBe(false);
    expect(redisStore.has("gk:ac:fake-cart-001")).toBe(true);
  });
});

describe("retry queue (/api/cron/retry-failed)", () => {
  it("requires CRON_SECRET bearer or ADMIN_TOKEN", async () => {
    captureLogs();
    mockFetch();
    expect((await retryCron(cronRequest("none"))).status).toBe(401);
    expect((await retryCron(cronRequest("bearer"))).status).toBe(200);
    expect((await retryCron(cronRequest("admin"))).status).toBe(200);
  });

  it("does nothing in dry-run mode", async () => {
    setEnv({ CRON_SECRET, DRY_RUN: "true" });
    captureLogs();
    expect(await (await retryCron(cronRequest())).json()).toMatchObject({
      mode: "dry_run",
      processed: 0,
    });
  });

  it("waits for the backoff, then retries a transient failure", async () => {
    captureLogs();
    const fetchFn = mockFetch(503, "busy");
    await webhook(post(PATH, fakeCart()));
    expect(due()).toEqual(["fake-cart-001"]);

    // Not due yet.
    expect(await (await retryCron(cronRequest())).json()).toMatchObject({ due: 0, processed: 0 });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    fetchFn.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await (await retryCron(cronRequest())).json()).toMatchObject({ sent: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("drops a queued cart that GoKwik's own retry already sent (no double message)", async () => {
    const logs = captureLogs();
    const fetchFn = mockFetch(503, "busy");
    await webhook(post(PATH, fakeCart()));
    fetchFn.mockResolvedValue(new Response("{}", { status: 200 }));
    await webhook(post(PATH, fakeCart())); // GoKwik retried and it went through

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await (await retryCron(cronRequest())).json()).toMatchObject({ skipped: 1, sent: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(due()).toEqual([]);
    expect(logs.text()).toContain('"reason":"duplicate"');
  });

  it("skips a queued cart once the shopper has ordered", async () => {
    captureLogs();
    const fetchFn = mockFetch(503, "busy");
    await webhook(post(PATH, fakeCart()));
    await orderCreated(shopifyRequest({ id: 9, phone: "+919000000001" }));

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await (await retryCron(cronRequest())).json()).toMatchObject({ skipped: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(due()).toEqual([]);
  });

  it("gives up after RETRY_MAX_ATTEMPTS and logs it", async () => {
    setEnv({ CRON_SECRET, RETRY_MAX_ATTEMPTS: "2" });
    const logs = captureLogs();
    mockFetch(500, "down");
    await webhook(post(PATH, fakeCart())); // attempt 1
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
    await retryCron(cronRequest()); // attempt 2 -> give up
    expect(due()).toEqual([]);
    expect(logs.text()).toContain("retry_gave_up");
  });

  it("without Redis a transient failure still returns 500 so GoKwik can retry", async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" });
    const logs = captureLogs();
    mockFetch(503);
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
    expect(logs.text()).toContain("retry_not_queued");
  });
});

describe("validation and payload shapes", () => {
  it("Redis outage -> 500 (store_error), nothing sent, so GoKwik retries", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    redisControl.down = true;
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("REQUIRE_RECOVERY_LINK=true skips carts without a link", async () => {
    setEnv({ REQUIRE_RECOVERY_LINK: "true" });
    const logs = captureLogs();
    const fetchFn = mockFetch();
    const res = await webhook(post(PATH, fakeCart({ kwik_link: undefined })));
    expect(await res.json()).toMatchObject({ sent: 0, skipped: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logs.text()).toContain("missing_recovery_link");
  });

  it("a non-URL link is ignored (falls back to STORE_URL by default)", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    await webhook(post(PATH, fakeCart({ kwik_link: "javascript:alert(1)" })));
    expect(sentBody(fetchFn).templateParams[1]).toBe("https://store.example.test");
  });

  describe("event-type filter (MAP_EVENT_TYPE + ALLOWED_EVENT_TYPES)", () => {
    beforeEach(() =>
      setEnv({ MAP_EVENT_TYPE: "cart_state", ALLOWED_EVENT_TYPES: "Address_Added, abandoned" }),
    );

    it("sends matching events (case-insensitive)", async () => {
      captureLogs();
      const fetchFn = mockFetch();
      await webhook(post(PATH, fakeCart({ cart_state: "ADDRESS_ADDED" })));
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it.each([["converted"], [undefined]])("skips %s", async (state) => {
      const logs = captureLogs();
      const fetchFn = mockFetch();
      await webhook(post(PATH, fakeCart({ cart_state: state })));
      expect(fetchFn).not.toHaveBeenCalled();
      expect(logs.text()).toContain("not_abandoned_event");
    });

    it("ALLOWED_EVENT_TYPES without MAP_EVENT_TYPE is a config error", async () => {
      setEnv({ ALLOWED_EVENT_TYPES: "abandoned" });
      const logs = captureLogs();
      expect((await webhook(post(PATH, fakeCart()))).status).toBe(500);
      expect(logs.text()).toContain("ALLOWED_EVENT_TYPES needs MAP_EVENT_TYPE");
    });
  });

  it.each([
    ["null", "null", 0],
    ["empty array", "[]", 0],
    ["array of junk", '[1, "x", null, true]', 0],
    ["empty object", "{}", 1],
  ])("unexpected body %s -> 200, nothing sent", async (_label, body, received) => {
    captureLogs();
    const fetchFn = mockFetch();
    const res = await webhook(post(PATH, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received, sent: 0, failed: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("finds fields in an unfamiliar nested structure", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    const body = {
      event: "something",
      payload: {
        checkout: {
          customer_details: { mobile_number: 9000000005, firstName: "NESTED" },
          links: { checkout_url: "https://checkout.example.test/n/5" },
          cart_id: "nested-5",
        },
      },
    };
    const res = await webhook(post(PATH, body));
    expect(await res.json()).toMatchObject({ sent: 1 });
    expect(sentBody(fetchFn)).toMatchObject({
      destination: "+919000000005",
      userName: "Nested",
      templateParams: ["Nested", "https://checkout.example.test/n/5"],
    });
  });

  it.each([
    ["letters", "call me maybe"],
    ["too short", "90000"],
    ["too long", "9000000000000"],
    ["wrong country code", "449000000001"],
  ])("invalid phone (%s) is skipped without calling AiSensy", async (_label, phone) => {
    const logs = captureLogs();
    const fetchFn = mockFetch();
    const res = await webhook(post(PATH, fakeCart({ phone })));
    expect(await res.json()).toMatchObject({ sent: 0, skipped: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logs.text()).toContain("invalid_phone");
  });

  it("missing/garbage name falls back to FALLBACK_NAME", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    await webhook(post(PATH, fakeCart({ first_name: "user@example.test" })));
    expect(sentBody(fetchFn).userName).toBe("there");
  });
});
