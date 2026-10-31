import { describe, expect, it } from "vitest";
import { extractFields, getPath, splitCarts } from "../src/extract";

describe("extractFields", () => {
  it("flat payload", () => {
    const ex = extractFields({
      cart_id: "fake-1",
      phone: "9000000001",
      first_name: "Testy",
      kwik_link: "https://checkout.example.test/r/fake-1",
      total_price: "1299.00",
      line_items: [{ title: "Fake Dress" }, { title: "Fake Top" }, { title: "Fake Scarf" }],
    });
    expect(ex.phone).toEqual({ value: "9000000001", path: "phone", via: "candidate" });
    expect(ex.firstName).toEqual({ value: "Testy", path: "first_name", via: "candidate" });
    expect(ex.link?.value).toBe("https://checkout.example.test/r/fake-1");
    expect(ex.cartId?.value).toBe("fake-1");
    expect(ex.total?.value).toBe("1299.00");
    expect(ex.itemsSummary?.value).toBe("Fake Dress and 2 more");
  });

  it("nested customer object", () => {
    const ex = extractFields({
      id: "fake-2",
      customer: { phone: "+91 90000 00002", first_name: "FAKENAME", email: "fake@example.test" },
      checkout_url: "https://checkout.example.test/c/fake-2",
      amount: 499,
      items: [{ name: "Only Fake Item" }],
    });
    expect(ex.phone).toMatchObject({ value: "+91 90000 00002", path: "customer.phone" });
    expect(ex.firstName).toMatchObject({ value: "Fakename", path: "customer.first_name" });
    expect(ex.link?.path).toBe("checkout_url");
    expect(ex.cartId).toMatchObject({ value: "fake-2", path: "id" });
    expect(ex.total?.value).toBe("499");
    expect(ex.itemsSummary?.value).toBe("Only Fake Item");
  });

  it("nested shipping_address", () => {
    const ex = extractFields({
      request_id: "fake-req-3",
      shipping_address: { phone: "090000-00003", first_name: "testy", city: "Faketown" },
      abandoned_checkout_url: "https://checkout.example.test/a/3",
    });
    expect(ex.phone).toMatchObject({ value: "090000-00003", path: "shipping_address.phone" });
    expect(ex.firstName).toMatchObject({ value: "Testy", path: "shipping_address.first_name" });
    expect(ex.link?.path).toBe("abandoned_checkout_url");
    expect(ex.cartId).toMatchObject({ value: "fake-req-3", path: "request_id" });
    expect(ex.total).toBeUndefined();
    expect(ex.itemsSummary).toBeUndefined();
  });

  it("deeply nested camelCase keys fall back to deep search", () => {
    const ex = extractFields({
      cartDetails: {
        customerInfo: { mobileNumber: "9000000005", fullName: "Testy Fakerson" },
        recoveryUrl: "https://checkout.example.test/deep/5",
        cartId: "deep-5",
      },
    });
    expect(ex.phone).toMatchObject({
      value: "9000000005",
      path: "cartDetails.customerInfo.mobileNumber",
      via: "deep",
    });
    expect(ex.firstName).toMatchObject({ value: "Testy", via: "deep" });
    expect(ex.link).toMatchObject({ path: "cartDetails.recoveryUrl", via: "deep" });
    expect(ex.cartId).toMatchObject({ value: "deep-5", via: "deep" });
  });

  it("full name fields keep only the first word", () => {
    expect(extractFields({ name: "Testy Fakerson" }).firstName?.value).toBe("Testy");
    expect(extractFields({ customer: { name: "  FAKE  PERSON " } }).firstName?.value).toBe("Fake");
  });

  it("ignores names that look like phones/emails and links that aren't URLs", () => {
    const ex = extractFields({ name: "9000000001", link: "not a url", phone: "9000000001" });
    expect(ex.firstName).toBeUndefined();
    expect(ex.link).toBeUndefined();
  });

  it("does not take a product name as the customer's name", () => {
    const ex = extractFields({ phone: "9000000001", line_items: [{ name: "Fake Kurta" }] });
    expect(ex.firstName).toBeUndefined();
  });

  it("MAP_* overrides win over candidates, and fall back when empty", () => {
    const cart = {
      phone: "9000000001",
      contact: { wa: "9000000006" },
      meta: { link: "https://checkout.example.test/override" },
    };
    const ex = extractFields(cart, { phone: "contact.wa", link: "meta.link", name: "nope.here" });
    expect(ex.phone).toEqual({ value: "9000000006", path: "contact.wa", via: "override" });
    expect(ex.link).toMatchObject({ path: "meta.link", via: "override" });
    expect(ex.firstName).toBeUndefined();

    const fallback = extractFields({ phone: "9000000001" }, { phone: "missing.path" });
    expect(fallback.phone).toMatchObject({ path: "phone", via: "candidate" });
  });
});

describe("getPath", () => {
  it("supports array indexes and case-insensitive keys", () => {
    expect(getPath({ Line_Items: [{ Title: "X" }] }, "line_items.0.title")).toBe("X");
    expect(getPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });
});

describe("splitCarts", () => {
  const cart = (n: number) => ({ phone: `900000000${n}`, cart_id: `fake-${n}` });

  it("single cart object", () => {
    expect(splitCarts(cart(1))).toEqual([{ cart: cart(1), at: "$" }]);
  });

  it("top-level array", () => {
    expect(splitCarts([cart(1), cart(2)]).map((c) => c.at)).toEqual(["$.0", "$.1"]);
  });

  it.each(["data", "carts", "abandoned_carts"])("{ %s: [...] } wrapper", (key) => {
    const carts = splitCarts({ event: "abandoned", [key]: [cart(1), cart(2), cart(3)] });
    expect(carts).toHaveLength(3);
    expect(carts[2]).toEqual({ cart: cart(3), at: `$.${key}.2` });
  });

  it("{ success, data: {cart} } wrapper", () => {
    expect(splitCarts({ success: true, data: cart(4) })).toEqual([{ cart: cart(4), at: "$.data" }]);
  });

  it("doesn't unwrap a cart that has its own `data` key", () => {
    const c = { ...cart(5), data: { note: "x" } };
    expect(splitCarts(c)).toEqual([{ cart: c, at: "$" }]);
  });

  it("ignores non-object array items", () => {
    expect(splitCarts([cart(1), "junk", 42, null])).toHaveLength(1);
  });
});
