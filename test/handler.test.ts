import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_TOKEN,
  AISENSY_URL,
  API_KEY,
  captureLogs,
  fakeCart,
  mockFetch,
  post,
  setEnv,
  WEBHOOK_TOKEN,
} from "./helpers";

const redisStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@upstash/redis", () => ({
  Redis: class {
    async set(key: string, value: string, opts?: { nx?: boolean }) {
      if (opts?.nx && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return "OK";
    }
    async del(key: string) {
      return redisStore.delete(key) ? 1 : 0;
    }
  },
}));

import { GET as webhookGet, POST as webhook } from "../api/gokwik/abandoned-cart";
import { GET as health } from "../api/health";
import { POST as testSend } from "../api/test-send";

const PATH = "/api/gokwik/abandoned-cart";

function sentBody(fetchFn: ReturnType<typeof mockFetch>, call = 0) {
  return JSON.parse(String(fetchFn.mock.calls[call]![1]!.body));
}

beforeEach(() => {
  redisStore.clear();
  setEnv();
});

describe("webhook auth", () => {
  it.each([
    ["wrong token", "wrong-token-but-long-enough"],
    ["missing token", ""],
  ])("%s -> 401 and logs only 'unauthorized'", async (_label, token) => {
    const logs = captureLogs();
    const fetchFn = mockFetch();
    const res = await webhook(post(PATH, fakeCart(), { token }));
    expect(res.status).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logs.lines).toHaveLength(1);
    expect(JSON.parse(logs.lines[0]!)).toEqual({ level: "warn", msg: "unauthorized" });
  });

  it("GET with the right token confirms the URL works", async () => {
    captureLogs();
    const url = `https://connector.example.test${PATH}?token=${WEBHOOK_TOKEN}`;
    expect((await webhookGet(new Request(url))).status).toBe(200);
    expect((await webhookGet(new Request(`${url}x`))).status).toBe(401);
  });
});

describe("webhook sending", () => {
  it("happy path: sends the correct AiSensy body", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, sent: 1, skipped: 0, failed: 0, mode: "live" });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe(AISENSY_URL);
    expect(fetchFn.mock.calls[0]![1]!.method).toBe("POST");
    expect(sentBody(fetchFn)).toEqual({
      apiKey: API_KEY,
      campaignName: "abandoned_cart_test",
      destination: "+919000000001",
      userName: "Testy",
      templateParams: ["Testy", "https://checkout.example.test/recover/fake-cart-001?x=1"],
      source: "gokwik-abandoned-cart",
      paramsFallbackValue: { FirstName: "there" },
    });
    expect(redisStore.has("gk:ac:fake-cart-001")).toBe(true);
  });

  it("uses the fallback name and STORE_URL when the cart lacks them", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    const cart = { phone: "9000000002" };
    await webhook(post(PATH, cart));
    const body = sentBody(fetchFn);
    expect(body.userName).toBe("there");
    expect(body.templateParams).toEqual(["there", "https://store.example.test"]);
  });

  it("builds params in AISENSY_TEMPLATE_PARAMS order", async () => {
    setEnv({
      AISENSY_TEMPLATE_PARAMS: "store_name, first_name,items_summary,cart_total,recovery_url",
    });
    captureLogs();
    const fetchFn = mockFetch();
    await webhook(post(PATH, fakeCart()));
    expect(sentBody(fetchFn).templateParams).toEqual([
      "Fake Store",
      "Testy",
      "Fake Dress and 1 more",
      "1299.00",
      "https://checkout.example.test/recover/fake-cart-001?x=1",
    ]);
  });

  it("adds a URL button suffix only when configured", async () => {
    setEnv({ AISENSY_BUTTON_URL_SUFFIX_FROM: "recovery_url_path" });
    captureLogs();
    const fetchFn = mockFetch();
    await webhook(post(PATH, fakeCart()));
    expect(sentBody(fetchFn).buttons).toEqual([
      {
        type: "button",
        sub_type: "url",
        index: 0,
        parameters: [{ type: "text", text: "recover/fake-cart-001?x=1" }],
      },
    ]);
  });

  it("dry run: no fetch, logs the masked body", async () => {
    setEnv({ DRY_RUN: "true" });
    const logs = captureLogs();
    const fetchFn = mockFetch();
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 1, sent: 1, mode: "dry_run" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(redisStore.size).toBe(0);

    const dry = logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg === "dry_run_would_send");
    expect(dry.body).toMatchObject({
      apiKey: "***",
      destination: "91XXXXXX0001",
      templateParams: ["Testy", "https://checkout.example.test/recover/fake-cart-001?x=1"],
    });
    expect(logs.text()).not.toContain(API_KEY);
    expect(logs.text()).not.toContain("9000000001");
  });

  it("AiSensy 500 -> handler 500 and dedupe key released, so a retry sends", async () => {
    captureLogs();
    const fetchFn = mockFetch(500, "upstream exploded");
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ received: 1, sent: 0, failed: 1 });
    expect(redisStore.has("gk:ac:fake-cart-001")).toBe(false);

    fetchFn.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const retry = await webhook(post(PATH, fakeCart()));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ sent: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])("AiSensy %i is transient -> 500", async (status) => {
    captureLogs();
    mockFetch(status);
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
  });

  it("network error is transient -> 500", async () => {
    captureLogs();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
    expect(redisStore.size).toBe(0);
  });

  it("AiSensy 400 -> skipped with 200, key kept, error scrubbed of phone digits", async () => {
    const logs = captureLogs();
    mockFetch(400, '{"message":"Invalid destination +919000000001"}');
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 1, sent: 0, skipped: 1, failed: 0 });
    expect(redisStore.has("gk:ac:fake-cart-001")).toBe(true);
    expect(logs.text()).toContain("aisensy_rejected");
    expect(logs.text()).not.toContain("9000000001");
  });

  it("duplicate cart -> skipped, AiSensy called once", async () => {
    const logs = captureLogs();
    const fetchFn = mockFetch();
    await webhook(post(PATH, fakeCart()));
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 1, sent: 0, skipped: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logs.text()).toContain('"reason":"duplicate"');
  });

  it("without a cart id, dedupes on sha256(phone+link)", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    const cart = { phone: "9000000003", checkout_url: "https://checkout.example.test/x" };
    await webhook(post(PATH, cart));
    await webhook(post(PATH, { ...cart, phone: "+91 90000 00003" }));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect([...redisStore.keys()][0]).toMatch(/^gk:ac:[0-9a-f]{64}$/);
  });

  it("missing and invalid phones are skipped with 200; invalid phone is masked in logs", async () => {
    const logs = captureLogs();
    const fetchFn = mockFetch();
    const res = await webhook(
      post(PATH, { data: [fakeCart({ phone: undefined }), fakeCart({ phone: "12345678" })] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 2, sent: 0, skipped: 2 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logs.text()).toContain("missing_phone");
    expect(logs.text()).toContain("invalid_phone");
    expect(logs.text()).toContain("XXXX5678");
    expect(logs.text()).not.toContain("12345678");
  });

  it("handles a wrapped batch with mixed outcomes", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    fetchFn.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    fetchFn.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    const carts = [
      fakeCart({ cart_id: "a" }),
      fakeCart({ cart_id: "b", phone: "9000000004" }),
      fakeCart({ cart_id: "c", phone: "" }),
    ];
    const res = await webhook(post(PATH, { carts }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 3, sent: 1, skipped: 2, failed: 0 });
  });

  it("accepts form-encoded bodies", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    const form = new URLSearchParams({
      phone: "9000000007",
      first_name: "Formy",
      checkout_url: "https://checkout.example.test/form",
    }).toString();
    const res = await webhook(
      post(PATH, form, { contentType: "application/x-www-form-urlencoded" }),
    );
    expect(res.status).toBe(200);
    expect(sentBody(fetchFn).destination).toBe("+919000000007");
  });

  it("accepts form-encoded JSON in a single field", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    const form = new URLSearchParams({ payload: JSON.stringify(fakeCart()) }).toString();
    await webhook(post(PATH, form, { contentType: "application/x-www-form-urlencoded" }));
    expect(sentBody(fetchFn).userName).toBe("Testy");
  });

  it("invalid JSON -> 400", async () => {
    captureLogs();
    const res = await webhook(post(PATH, "{not json"));
    expect(res.status).toBe(400);
  });

  it("works without Redis (dedupe off)", async () => {
    setEnv({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" });
    captureLogs();
    const fetchFn = mockFetch();
    await webhook(post(PATH, fakeCart()));
    await webhook(post(PATH, fakeCart()));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("config errors", () => {
  it("missing required var -> 500 with a generic message, details only in logs", async () => {
    setEnv({ GOKWIK_WEBHOOK_TOKEN: "" });
    const logs = captureLogs();
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Server misconfigured. Check the Vercel logs." });
    expect(logs.text()).toContain("GOKWIK_WEBHOOK_TOKEN is required");
  });

  it("live mode without AiSensy credentials -> 500", async () => {
    setEnv({ AISENSY_API_KEY: "" });
    const logs = captureLogs();
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
    expect(logs.text()).toContain("AISENSY_API_KEY is required");
  });

  it("unknown template param key -> 500", async () => {
    setEnv({ AISENSY_TEMPLATE_PARAMS: "first_name,coupon" });
    const logs = captureLogs();
    const res = await webhook(post(PATH, fakeCart()));
    expect(res.status).toBe(500);
    expect(logs.text()).toContain("unknown key(s) coupon");
  });
});

describe("/api/health", () => {
  it("reports modes and dedupe without secrets", async () => {
    setEnv({ DRY_RUN: "true", DISCOVERY_MODE: "true" });
    const res = health();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      dryRun: true,
      discoveryMode: true,
      dedupe: "redis",
    });
    expect(text).not.toContain(API_KEY);
  });

  it("dedupe off when Redis isn't configured; defaults are the safe modes", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("DRY_RUN", "");
    vi.stubEnv("DISCOVERY_MODE", "");
    expect(await health().json()).toEqual({
      ok: true,
      dryRun: true,
      discoveryMode: true,
      dedupe: "off",
    });
  });
});

describe("/api/test-send", () => {
  const TS = "/api/test-send";

  it("401 without the admin token", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    expect((await testSend(post(TS, "", { token: "" }))).status).toBe(401);
    expect((await testSend(post(TS, "", { token: "wrong-admin-token-xxxxxx" }))).status).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends sample values to TEST_PHONE", async () => {
    captureLogs();
    const fetchFn = mockFetch();
    const res = await testSend(post(TS, "", { token: ADMIN_TOKEN }));
    expect(res.status).toBe(200);
    expect(sentBody(fetchFn)).toMatchObject({
      destination: "+919000000099",
      userName: "Test",
      templateParams: ["Test", "https://store.example.test"],
    });
    const out = (await res.json()) as { sent: { apiKey: string; destination: string } };
    expect(out.sent.apiKey).toBe("***");
    expect(out.sent.destination).toBe("91XXXXXX0099");
  });

  it("dry run returns the masked body without calling AiSensy", async () => {
    setEnv({ DRY_RUN: "true" });
    captureLogs();
    const fetchFn = mockFetch();
    const res = await testSend(post(TS, "", { token: ADMIN_TOKEN }));
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports AiSensy errors with 502", async () => {
    captureLogs();
    mockFetch(401, '{"message":"Invalid API key"}');
    const res = await testSend(post(TS, "", { token: ADMIN_TOKEN }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, aisensyStatus: 401 });
  });
});
