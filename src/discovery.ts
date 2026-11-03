/**
 * Discovery mode: log the *shape* of incoming payloads (key paths, types, masked
 * samples) and what the extractor picked, so the mapping can be fixed from one real
 * GoKwik webhook without ever logging customer data.
 */
import type { Extraction, FieldName } from "./extract";
import { log } from "./log";
import { maskPhone } from "./phone";

export interface ShapeEntry {
  path: string;
  type: string;
  sample: string;
}

const MAX_ENTRIES = 300;
const MAX_DEPTH = 8;
const ENTRIES_PER_LOG_LINE = 40;

const PHONE_KEY = /phone|mobile|msisdn|whatsapp|contact/i;
const PHONE_VALUE = /^\+?[\d\s\-().]{7,}$/;

function describeUrl(s: string): string | undefined {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.protocol}//${u.host}/…(${s.length})`;
  } catch {
    return undefined;
  }
}

/** Masked sample of a single value. Never returns enough to identify a customer. */
export function maskSample(key: string, value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return String(value);
  if (typeof value !== "string") return typeof value;

  const s = value.trim();
  if (!s) return "(empty)";
  if (s.includes("@")) return "[email]";
  const digits = s.replace(/\D/g, "");
  if ((PHONE_KEY.test(key) || PHONE_VALUE.test(s)) && digits.length >= 7) {
    return `[phone: ${digits.length} digits${s.startsWith("+") ? ", + prefix" : ""}]`;
  }
  const url = describeUrl(s);
  if (url) return url;
  return `${s.slice(0, 2)}…(${s.length})`;
}

/** Every key path in `value` with its type and a masked sample. Arrays: first item only. */
export function describeShape(value: unknown): { entries: ShapeEntry[]; truncated: boolean } {
  const entries: ShapeEntry[] = [];
  let truncated = false;

  const walk = (node: unknown, path: string, key: string, depth: number) => {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    if (Array.isArray(node)) {
      entries.push({ path: path || "$", type: "array", sample: `length ${node.length}` });
      if (node.length && depth < MAX_DEPTH) walk(node[0], path ? `${path}.0` : "0", key, depth + 1);
    } else if (typeof node === "object" && node !== null) {
      if (path) entries.push({ path, type: "object", sample: `${Object.keys(node).length} keys` });
      if (depth >= MAX_DEPTH) return;
      for (const [k, child] of Object.entries(node)) {
        walk(child, path ? `${path}.${k}` : k, k, depth + 1);
      }
    } else {
      entries.push({
        path: path || "$",
        type: node === null ? "null" : typeof node,
        sample: maskSample(key, node),
      });
    }
  };

  walk(value, "", "", 0);
  return { entries, truncated };
}

function maskPicked(field: FieldName, value: string, countryCode: string): string {
  if (field === "phone") return maskPhone(value, countryCode);
  return maskSample(field, value);
}

export interface DiscoveryInfo {
  cartIndex: number;
  at: string;
  cart: unknown;
  extraction: Extraction;
  phoneValid: boolean;
  countryCode: string;
}

export function logDiscovery(info: DiscoveryInfo): void {
  const { entries, truncated } = describeShape(info.cart);
  const parts = Math.max(1, Math.ceil(entries.length / ENTRIES_PER_LOG_LINE));
  for (let p = 0; p < parts; p++) {
    log.info("discovery_shape", {
      cartIndex: info.cartIndex,
      at: info.at,
      part: `${p + 1}/${parts}`,
      truncated,
      // "path  type  sample" strings keep each log line compact and easy to scan.
      shape: entries
        .slice(p * ENTRIES_PER_LOG_LINE, (p + 1) * ENTRIES_PER_LOG_LINE)
        .map((e) => `${e.path}  ${e.type}  ${e.sample}`),
    });
  }

  const fields = [
    "phone",
    "firstName",
    "link",
    "cartId",
    "total",
    "itemsSummary",
    "eventType",
  ] as const;
  const picked: Record<string, unknown> = {};
  for (const f of fields) {
    const pick = info.extraction[f];
    picked[f] = pick
      ? { path: pick.path, via: pick.via, sample: maskPicked(f, pick.value, info.countryCode) }
      : "NOT FOUND";
  }
  log.info("discovery_extracted", {
    cartIndex: info.cartIndex,
    at: info.at,
    phoneValid: info.phoneValid,
    picked,
  });
}
