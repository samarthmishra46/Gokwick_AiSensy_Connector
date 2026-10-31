/**
 * POST /api/test-send?token=<ADMIN_TOKEN>
 *
 * Sends the campaign template to TEST_PHONE with sample values, so AiSensy can be
 * checked before GoKwik is connected. Respects DRY_RUN; ignores DISCOVERY_MODE.
 */
import { BuildError, buildBody, logDryRun, maskBody, sendToAiSensy } from "../src/aisensy";
import { assertTestSendConfig, loadConfig } from "../src/config";
import { handleError, json, tokenMatches, unauthorized } from "../src/http";
import { log } from "../src/log";
import { maskPhone, normalizePhone } from "../src/phone";

export async function POST(request: Request): Promise<Response> {
  try {
    const cfg = loadConfig();
    if (!cfg.adminToken) {
      log.error("config_invalid", { where: "test-send", problems: ["ADMIN_TOKEN is not set"] });
    }
    if (!tokenMatches(request, cfg.adminToken)) return unauthorized();
    assertTestSendConfig(cfg);

    const phone = normalizePhone(cfg.testPhone, cfg.defaultCountryCode);
    if (!phone.ok) throw new Error("unreachable: TEST_PHONE validated by assertTestSendConfig");

    let body;
    try {
      body = buildBody(cfg, {
        phone: phone.digits,
        firstName: "Test",
        recoveryUrl: cfg.storeUrl,
        cartTotal: "999",
        itemsSummary: "Sample item and 1 more",
      });
    } catch (err) {
      if (!(err instanceof BuildError)) throw err;
      return json({ ok: false, error: `Cannot build message: ${err.message}` }, 400);
    }

    const masked = maskBody(body, cfg.defaultCountryCode);
    if (cfg.dryRun) {
      logDryRun(cfg, body, { where: "test-send" });
      return json({ ok: true, dryRun: true, wouldSend: masked });
    }

    const res = await sendToAiSensy(cfg, body);
    const phoneMasked = maskPhone(phone.digits, cfg.defaultCountryCode);
    if (res.ok) {
      log.info("test_send_ok", { phone: phoneMasked, httpStatus: res.status });
      return json({ ok: true, dryRun: false, aisensyStatus: res.status, sent: masked });
    }
    log.error("test_send_failed", {
      phone: phoneMasked,
      httpStatus: res.status,
      detail: res.reason,
    });
    return json(
      {
        ok: false,
        dryRun: false,
        aisensyStatus: res.status ?? null,
        error: res.reason,
        sent: masked,
      },
      502,
    );
  } catch (err) {
    return handleError(err, "test-send");
  }
}
