import { createHash, timingSafeEqual } from "node:crypto";
import { ConfigError } from "./config";
import { log } from "./log";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Constant-time comparison of the `?token=` query param against the expected secret. */
export function tokenMatches(request: Request, expected: string | undefined): boolean {
  const given = new URL(request.url).searchParams.get("token");
  if (!given || !expected) return false;
  // Hash both sides so timingSafeEqual always compares equal-length buffers.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function unauthorized(): Response {
  log.warn("unauthorized");
  return json({ error: "unauthorized" }, 401);
}

/** Log what's wrong (variable names only) and return a generic 500. */
export function handleError(err: unknown, where: string): Response {
  if (err instanceof ConfigError) {
    log.error("config_invalid", { where, problems: err.problems });
    return json({ error: "Server misconfigured. Check the Vercel logs." }, 500);
  }
  log.error("unhandled_error", {
    where,
    error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
  });
  return json({ error: "Internal error" }, 500);
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Parse the request body as JSON, or as form-encoded data as a fallback.
 * Form fields whose value is itself JSON (e.g. `payload={...}`) are decoded too.
 */
export async function readBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const text = await request.text();
  if (!text.trim()) return { ok: false, reason: "empty body" };
  const type = request.headers.get("content-type") ?? "";

  if (!type.includes("application/x-www-form-urlencoded")) {
    const parsed = tryJson(text);
    if (parsed !== undefined) return { ok: true, body: parsed };
    if (!text.includes("=")) return { ok: false, reason: "body is not valid JSON" };
  }

  const form: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const t = v.trim();
    form[k] = t.startsWith("{") || t.startsWith("[") ? (tryJson(t) ?? v) : v;
  }
  if (!Object.keys(form).length) return { ok: false, reason: "body could not be parsed" };
  // A single field holding the whole JSON document: unwrap it.
  const values = Object.values(form);
  if (values.length === 1 && typeof values[0] === "object" && values[0] !== null) {
    return { ok: true, body: values[0] };
  }
  return { ok: true, body: form };
}
