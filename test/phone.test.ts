import { describe, expect, it } from "vitest";
import { maskPhone, normalizePhone, toAiSensyDestination } from "../src/phone";

describe("normalizePhone", () => {
  it.each([
    ["9000000001", "919000000001"], // 10-digit
    ["+919000000001", "919000000001"], // +91
    ["919000000001", "919000000001"], // 12 digits starting with 91
    ["09000000001", "919000000001"], // 0-prefixed
    ["0091 90000 00001", "919000000001"], // 00 international prefix
    ["+91 90000 00001", "919000000001"], // spaced
    ["(+91) 90000-00001", "919000000001"], // brackets and dashes
    ["90000.00001", "919000000001"], // dots
    [9000000001, "919000000001"], // number type
  ])("%s -> %s", (raw, expected) => {
    expect(normalizePhone(raw)).toEqual({ ok: true, digits: expected });
  });

  it.each([
    ["", "empty"],
    [null, "empty"],
    [undefined, "empty"],
    ["000", "empty"],
    ["90000", "bad_length"],
    ["90000000011", "bad_length"], // 11 digits
    ["929000000001", "bad_length"], // 12 digits, wrong country code
    ["+1 415 555 0100", "bad_length"],
    ["9000O00001", "non_numeric"], // letter O
    ["not a phone", "non_numeric"],
  ])("rejects %s (%s)", (raw, reason) => {
    expect(normalizePhone(raw)).toEqual({ ok: false, reason });
  });

  it("uses a custom default country code", () => {
    expect(normalizePhone("4155550100", "1")).toEqual({ ok: true, digits: "14155550100" });
  });
});

describe("toAiSensyDestination", () => {
  it("adds a + prefix", () => {
    expect(toAiSensyDestination("919000000001")).toBe("+919000000001");
  });
});

describe("maskPhone", () => {
  it("shows the country code and last 4 only", () => {
    expect(maskPhone("919000001234")).toBe("91XXXXXX1234");
    expect(maskPhone("+919000001234")).toBe("91XXXXXX1234");
  });
  it("masks odd inputs without revealing more than 4 digits", () => {
    expect(maskPhone("90000")).toBe("X0000");
    expect(maskPhone("12")).toBe("XXXX");
    expect(maskPhone(undefined)).toBe("XXXX");
  });
});
