import { vi } from "vitest";

export const WEBHOOK_TOKEN = "test-webhook-token-0123456789";
export const ADMIN_TOKEN = "test-admin-token-0123456789";
export const API_KEY = "fake-aisensy-key-DO-NOT-LOG";
export const AISENSY_URL = "https://aisensy.example.test/campaign/t1/api/v2";

const BASE_ENV: Record<string, string> = {
  GOKWIK_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  AISENSY_API_KEY: API_KEY,
  AISENSY_CAMPAIGN_NAME: "abandoned_cart_test",
  AISENSY_API_URL: AISENSY_URL,
  AISENSY_TEMPLATE_PARAMS: "first_name,recovery_url",
  AISENSY_BUTTON_URL_SUFFIX_FROM: "",
  FALLBACK_NAME: "there",
  STORE_NAME: "Fake Store",
  STORE_URL: "https://store.example.test",
  DEFAULT_COUNTRY_CODE: "91",
  DRY_RUN: "false",
  DISCOVERY_MODE: "false",
  ADMIN_TOKEN: ADMIN_TOKEN,
  TEST_PHONE: "9000000099",
  UPSTASH_REDIS_REST_URL: "https://redis.example.test",
  UPSTASH_REDIS_REST_TOKEN: "fake-redis-token",
  KV_REST_API_URL: "",
  KV_REST_API_TOKEN: "",
  DEDUPE_TTL_SECONDS: "172800",
  MAP_PHONE: "",
  MAP_NAME: "",
  MAP_LINK: "",
  MAP_CART_ID: "",
  MAP_TOTAL: "",
};

/** Stub every env var the app reads, so the developer's shell can't leak into tests. */
export function setEnv(overrides: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(k, v);
}

/** Collect everything written to console.* as one string per line. */
export function captureLogs(): { lines: string[]; text: () => string } {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "warn").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return { lines, text: () => lines.join("\n") };
}

export function mockFetch(status = 200, body = '{"success":"true"}') {
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(body, { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function post(
  path: string,
  body: unknown,
  { token = WEBHOOK_TOKEN, contentType = "application/json" } = {},
): Request {
  const url = new URL(`https://connector.example.test${path}`);
  if (token) url.searchParams.set("token", token);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** An obviously fake cart. */
export function fakeCart(overrides: Record<string, unknown> = {}) {
  return {
    cart_id: "fake-cart-001",
    phone: "9000000001",
    first_name: "Testy",
    kwik_link: "https://checkout.example.test/recover/fake-cart-001?x=1",
    total_price: "1299.00",
    line_items: [{ title: "Fake Dress" }, { title: "Fake Top" }],
    ...overrides,
  };
}
