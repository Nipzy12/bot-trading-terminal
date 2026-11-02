import { createHmac, randomUUID } from "node:crypto";
import { encrypt, decrypt } from "./vault.js";
import type { Database } from "./database.js";
import { ProviderError } from "./exness.js";
import type { ExnessReader } from "./exness.js";
// Data only: never contains cookies, session decisions, credentials, or signed headers.
export class LiveBootstrapCache {
  private pending = new Map<string, Promise<unknown>>();
  async reuse<T>(
    db: Database,
    owner: string,
    id: string,
    symbol: string,
    interval: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const key = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
      .update(JSON.stringify([owner, id, symbol, interval]))
      .digest("hex");
    const active = this.pending.get(key);
    if (active) return active as Promise<T>;
    const work = (async () => {
      const cached = await db.query(
        "SELECT envelope FROM nexus_private.nexus_live_bootstrap WHERE cache_key=$1 AND expires_at>now()",
        [key],
      );
      if (cached.rows[0]?.envelope)
        return decrypt(
          cached.rows[0].envelope,
          owner,
          `live-cache:${key}`,
        ) as T;
      const token = randomUUID();
      const lock = await db.query(
        "INSERT INTO nexus_private.nexus_live_bootstrap(cache_key,token,lock_until,expires_at) VALUES($1,$2,now()+interval '15 seconds',now()) ON CONFLICT(cache_key) DO UPDATE SET token=excluded.token,lock_until=excluded.lock_until,envelope=NULL WHERE nexus_live_bootstrap.lock_until<now() AND nexus_live_bootstrap.expires_at<=now() RETURNING token",
        [key, token],
      );
      if (!lock.rows.length)
        throw new ProviderError("RATE_LIMITED", 429, 15, {
          rateLimitSource: "INTERNAL_PROVIDER_REST",
        });
      try {
        const value = await load();
        await db.query(
          "UPDATE nexus_private.nexus_live_bootstrap SET envelope=$3,expires_at=now()+interval '5 seconds',lock_until=now() WHERE cache_key=$1 AND token=$2",
          [key, token, encrypt(value, owner, `live-cache:${key}`)],
        );
        return value;
      } catch (error) {
        await db.query(
          "DELETE FROM nexus_private.nexus_live_bootstrap WHERE cache_key=$1 AND token=$2",
          [key, token],
        );
        throw error;
      }
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }
}
const cache = new LiveBootstrapCache();
export function liveBootstrap(
  db: Database,
  owner: string,
  id: string,
  symbol: string,
  interval: number,
  reader: ExnessReader,
) {
  return cache.reuse(db, owner, id, symbol, interval, async () => ({
    prepared: await reader.prepareLive(symbol),
    candles: await reader.candles(symbol, interval),
  }));
}
