/** GET /api/health: current mode flags, no secrets. */
import { assertWebhookConfig, ConfigError, loadConfig } from "../src/config";
import { handleError, json } from "../src/http";
import { log } from "../src/log";

export function GET(): Response {
  try {
    const cfg = loadConfig();
    let ok = true;
    try {
      assertWebhookConfig(cfg);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      ok = false;
      log.error("config_invalid", { where: "health", problems: err.problems });
    }
    return json(
      {
        ok,
        dryRun: cfg.dryRun,
        discoveryMode: cfg.discoveryMode,
        dedupe: cfg.redis ? "redis" : "off",
      },
      ok ? 200 : 500,
    );
  } catch (err) {
    return handleError(err, "health");
  }
}
