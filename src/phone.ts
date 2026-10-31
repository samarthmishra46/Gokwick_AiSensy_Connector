export type PhoneResult =
  { ok: true; digits: string } | { ok: false; reason: "empty" | "non_numeric" | "bad_length" };

/**
 * Normalise a raw phone value to full international digits, e.g. "919876543210".
 *
 * - strips spaces, dashes, dots, brackets, a leading "+" and leading zeros
 * - 10 digits                         -> prefix the default country code
 * - country code + 10 digits          -> keep
 * - anything else                     -> invalid
 */
export function normalizePhone(raw: unknown, countryCode = "91"): PhoneResult {
  if (raw === null || raw === undefined) return { ok: false, reason: "empty" };
  let s = String(raw).trim();
  if (!s) return { ok: false, reason: "empty" };

  s = s
    .replace(/[\s\-().]/g, "")
    .replace(/^\+/, "")
    .replace(/^0+/, "");
  if (!s) return { ok: false, reason: "empty" };
  if (!/^\d+$/.test(s)) return { ok: false, reason: "non_numeric" };

  if (s.length === 10) return { ok: true, digits: countryCode + s };
  if (s.length === countryCode.length + 10 && s.startsWith(countryCode)) {
    return { ok: true, digits: s };
  }
  return { ok: false, reason: "bad_length" };
}

/**
 * The phone format AiSensy's `destination` field gets.
 * AiSensy's API reference shows "+917428526285" and says the "+" is optional for
 * Indian numbers but required for other countries, so we always send "+<digits>".
 * Change it here if AiSensy ever wants something else.
 */
export function toAiSensyDestination(digits: string): string {
  return `+${digits}`;
}

/** Mask a phone for logs: "919876541234" -> "91XXXXXX1234". Shows the last 4 digits only. */
export function maskPhone(raw: unknown, countryCode = "91"): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length <= 4) return "X".repeat(Math.max(digits.length, 4));
  const last4 = digits.slice(-4);
  if (digits.length === countryCode.length + 10 && digits.startsWith(countryCode)) {
    return countryCode + "X".repeat(digits.length - countryCode.length - 4) + last4;
  }
  return "X".repeat(digits.length - 4) + last4;
}
