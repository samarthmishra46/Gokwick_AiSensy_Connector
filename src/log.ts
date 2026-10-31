/**
 * Structured one-line JSON logs (readable in the Vercel log viewer).
 *
 * Rule for every caller: never pass raw webhook payloads, API keys, full phone
 * numbers or emails into these functions. Mask first (see phone.ts / discovery.ts).
 */

type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};

/** Replace any run of 8+ digits (likely a phone number) in free text, keeping the last 4. */
export function scrubDigits(text: string): string {
  return text.replace(/\+?\d[\d\s-]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 8 ? "X".repeat(digits.length - 4) + digits.slice(-4) : m;
  });
}

/** Mask anything that looks like an email address. */
export function scrubEmails(text: string): string {
  return text.replace(/[^\s@"']+@[^\s@"']+\.[^\s@"']+/g, "[email]");
}
