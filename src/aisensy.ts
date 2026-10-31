import type { Config, TemplateParamKey } from "./config";
import { log, scrubDigits, scrubEmails } from "./log";
import { maskPhone, toAiSensyDestination } from "./phone";

export const SOURCE = "gokwik-abandoned-cart";
const DEFAULT_TIMEOUT_MS = 8_000;

/** Everything we know about one recipient, already cleaned up. */
export interface Recipient {
  /** Normalised digits, e.g. "919876543210". */
  phone: string;
  firstName?: string;
  recoveryUrl: string;
  cartTotal?: string;
  itemsSummary?: string;
}

export interface AiSensyButton {
  type: "button";
  sub_type: "url";
  index: number;
  parameters: { type: "text"; text: string }[];
}

export interface AiSensyBody {
  apiKey: string;
  campaignName: string;
  destination: string;
  userName: string;
  templateParams: string[];
  source: string;
  buttons?: AiSensyButton[];
  paramsFallbackValue: Record<string, string>;
}

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; kind: "transient" | "permanent"; status?: number; reason: string };

/** WhatsApp rejects template params containing newlines, tabs or 4+ consecutive spaces. */
function cleanParam(v: string): string {
  return v.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** For a button URL like https://www.themisstt.com/{{1}}: the part after the domain. */
export function recoveryUrlPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.replace(/^\/+/, "");
  } catch {
    return "";
  }
}

export function buildTemplateParams(cfg: Config, r: Recipient): string[] {
  const values: Record<TemplateParamKey, string> = {
    first_name: r.firstName || cfg.fallbackName,
    recovery_url: r.recoveryUrl,
    cart_total: r.cartTotal || "-",
    items_summary: r.itemsSummary || "your items",
    store_name: cfg.storeName,
  };
  return cfg.templateParams.map((k) => cleanParam(values[k]));
}

export class BuildError extends Error {}

export function buildBody(cfg: Config, r: Recipient): AiSensyBody {
  const body: AiSensyBody = {
    apiKey: cfg.aisensyApiKey ?? "",
    campaignName: cfg.aisensyCampaignName ?? "",
    destination: toAiSensyDestination(r.phone),
    userName: cleanParam(r.firstName || cfg.fallbackName),
    templateParams: buildTemplateParams(cfg, r),
    source: SOURCE,
    // Not in AiSensy's public API reference; matches the sample shown in the
    // dashboard's API-campaign test panel. Harmless if ignored: we always fill
    // every template param ourselves.
    paramsFallbackValue: { FirstName: cfg.fallbackName },
  };

  if (cfg.buttonUrlSuffixFrom === "recovery_url_path") {
    const suffix = recoveryUrlPath(r.recoveryUrl);
    if (!suffix) throw new BuildError("recovery link has no path to use as the URL button suffix");
    body.buttons = [
      {
        type: "button",
        sub_type: "url",
        index: 0,
        parameters: [{ type: "text", text: suffix }],
      },
    ];
  }
  return body;
}

/** Copy of the body that's safe to log or return: API key hidden, phone masked. */
export function maskBody(body: AiSensyBody, countryCode = "91"): AiSensyBody {
  return {
    ...body,
    apiKey: body.apiKey ? "***" : "(not set)",
    destination: maskPhone(body.destination, countryCode),
  };
}

export async function sendToAiSensy(
  cfg: Config,
  body: AiSensyBody,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(cfg.aisensyApiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const reason = name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : `network: ${name}`;
    return { ok: false, kind: "transient", reason };
  }

  if (res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: true, status: res.status };
  }

  // AiSensy error bodies are short messages; scrub anything phone/email-like anyway.
  const text = await res.text().catch(() => "");
  const reason = scrubEmails(scrubDigits(text.slice(0, 300))) || res.statusText;
  const transient = res.status === 429 || res.status >= 500;
  return { ok: false, kind: transient ? "transient" : "permanent", status: res.status, reason };
}

export function logDryRun(cfg: Config, body: AiSensyBody, fields: Record<string, unknown> = {}) {
  log.info("dry_run_would_send", {
    ...fields,
    url: cfg.aisensyApiUrl,
    body: maskBody(body, cfg.defaultCountryCode),
  });
}
