/**
 * In-memory stand-in for @upstash/redis (only the commands the connector uses).
 * Use with: vi.mock("@upstash/redis", () => import("./fakeRedis"));
 */
export const redisStore = new Map<string, unknown>();
export const zsets = new Map<string, Map<string, number>>();
/** Set to make every command throw (simulates Upstash being down). */
export const redisControl = { down: false };

export function resetRedis(): void {
  redisStore.clear();
  zsets.clear();
  redisControl.down = false;
}

function check(): void {
  if (redisControl.down) throw new Error("fake redis unavailable");
}

export class Redis {
  constructor(_opts: unknown) {}

  async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
    check();
    if (opts?.nx && redisStore.has(key)) return null;
    // Upstash serialises to JSON and parses on read; mimic that so shapes round-trip.
    redisStore.set(key, JSON.parse(JSON.stringify(value)));
    return "OK";
  }
  async get(key: string) {
    check();
    return redisStore.has(key) ? redisStore.get(key) : null;
  }
  async del(key: string) {
    check();
    return redisStore.delete(key) ? 1 : 0;
  }
  async exists(key: string) {
    check();
    return redisStore.has(key) ? 1 : 0;
  }
  async zadd(key: string, sm: { score: number; member: string }) {
    check();
    const z = zsets.get(key) ?? new Map<string, number>();
    z.set(sm.member, sm.score);
    zsets.set(key, z);
    return 1;
  }
  async zrange(key: string, min: number, max: number, opts?: { count?: number }) {
    check();
    const z = zsets.get(key) ?? new Map<string, number>();
    return [...z.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(0, opts?.count ?? Infinity)
      .map(([m]) => m);
  }
  async zrem(key: string, member: string) {
    check();
    return zsets.get(key)?.delete(member) ? 1 : 0;
  }
}
