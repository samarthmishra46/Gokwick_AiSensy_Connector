import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs, mockFetch, post, setEnv } from "./helpers";

vi.mock("@upstash/redis", () => ({
  Redis: class {
    set = vi.fn(async () => "OK");
    del = vi.fn(async () => 1);
  },
}));

import { POST as webhook } from "../api/gokwik/abandoned-cart";
import { describeShape, maskSample } from "../src/discovery";

const PATH = "/api/gokwik/abandoned-cart";

// Obviously fake PII. None of these strings may appear in log output.
const PII = {
  phone: "9000012345",
  name: "Fakeperson",
  lastName: "Notarealname",
  email: "fake.person@example.test",
  address: "221B Fake Street",
  pincode: "560099",
  link: "https://checkout.example.test/recover/secret-token-xyz",
};

const payload = {
  event: "abandoned_cart",
  data: [
    {
      request_id: "fake-req-1",
      customer: {
        first_name: PII.name,
        last_name: PII.lastName,
        email: PII.email,
        phone: `+91${PII.phone}`,
      },
      shipping_address: { address1: PII.address, zip: PII.pincode, city: "Faketown" },
      abc_link: PII.link,
      total_price: 1299,
      line_items: [{ title: "Fake Dress", quantity: 1 }],
      accepts_marketing: true,
      coupon: null,
    },
  ],
};

beforeEach(() => setEnv({ DISCOVERY_MODE: "true", DRY_RUN: "true" }));

describe("discovery mode", () => {
  it("logs the payload shape and picks, sends nothing, leaks no PII", async () => {
    const logs = captureLogs();
    const fetchFn = mockFetch();

    const res = await webhook(post(PATH, payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: 1,
      sent: 0,
      skipped: 1,
      failed: 0,
      mode: "discovery",
    });
    expect(fetchFn).not.toHaveBeenCalled();

    const parsed = logs.lines.map((l) => JSON.parse(l));
    const shape = parsed.filter((l) => l.msg === "discovery_shape").flatMap((l) => l.shape);
    expect(shape).toEqual(
      expect.arrayContaining([
        "customer.phone  string  [phone: 12 digits, + prefix]",
        "customer.email  string  [email]",
        "customer.first_name  string  Fa…(10)",
        "abc_link  string  https://checkout.example.test/…(54)",
        "total_price  number  number",
        "line_items  array  length 1",
        "line_items.0.title  string  Fa…(10)",
        "accepts_marketing  boolean  true",
        "coupon  null  null",
      ]),
    );

    const picked = parsed.find((l) => l.msg === "discovery_extracted");
    expect(picked.at).toBe("$.data.0");
    expect(picked.phoneValid).toBe(true);
    expect(picked.picked.phone).toEqual({
      path: "customer.phone",
      via: "candidate",
      sample: "91XXXXXX2345",
    });
    expect(picked.picked.firstName).toMatchObject({ path: "customer.first_name" });
    expect(picked.picked.link).toMatchObject({ path: "abc_link" });
    expect(picked.picked.cartId).toMatchObject({ path: "request_id" });

    const text = logs.text();
    for (const value of Object.values(PII)) expect(text).not.toContain(value);
    expect(text).not.toContain("secret-token");
  });

  it("reports fields it couldn't find", async () => {
    const logs = captureLogs();
    mockFetch();
    await webhook(post(PATH, { something: "else" }));
    const picked = logs.lines
      .map((l) => JSON.parse(l))
      .find((l) => l.msg === "discovery_extracted");
    expect(picked.picked.phone).toBe("NOT FOUND");
    expect(picked.phoneValid).toBe(false);
  });
});

describe("maskSample", () => {
  it.each([
    ["phone", "9000012345", "[phone: 10 digits]"],
    ["contact", 9000012345, "number"],
    ["note", "+91 90000 12345", "[phone: 12 digits, + prefix]"],
    ["email", "x@y.test", "[email]"],
    ["city", "Faketown", "Fa…(8)"],
    ["url", "http://a.example.test/p?q=1", "http://a.example.test/…(27)"],
    ["empty", "  ", "(empty)"],
  ])("%s=%s -> %s", (key, value, expected) => {
    expect(maskSample(key, value)).toBe(expected);
  });
});

describe("describeShape", () => {
  it("caps very large payloads", () => {
    const big = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const { entries, truncated } = describeShape(big);
    expect(entries).toHaveLength(300);
    expect(truncated).toBe(true);
  });
});
