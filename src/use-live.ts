import {
  preflightCode,
  preflightCodes,
  rateInfo,
  type RateInfo,
} from "./live-diagnostics";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { acceptTick, reconnectDelay, type Tick } from "./live";
import { validateBars, type Bar } from "./backtest";
export function useLive(
  enabled: boolean,
  symbol: string,
  interval: number,
  epoch: number,
  handlers: {
    basis: (id: string, bars: Bar[]) => void;
    tick: (t: Tick) => void;
    status: (s: string) => void;
    rate?: (r: RateInfo) => void;
  },
) {
  const until = useRef(0),
    blocked = useRef(false),
    lastEpoch = useRef(epoch);
  const [remaining, setRemaining] = useState(0);
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    if (lastEpoch.current !== epoch) {
      lastEpoch.current = epoch;
      if (Date.now() >= until.current) blocked.current = false;
    }
    let socket: WebSocket | undefined,
      done = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      last = 0,
      id = "",
      attempt = 0,
      reason = "",
      healthy = false;
    const saved = () => {
      try {
        const v = JSON.parse(
          localStorage.getItem("nexus.live.cooldown") ?? "null",
        );
        return typeof v?.until === "number" &&
          v.until > Date.now() &&
          v.until <= Date.now() + 86400000
          ? v.until
          : 0;
      } catch {
        return 0;
      }
    };
    until.current = Math.max(until.current, saved());
    const status = (s: string) => h.current.status(s);
    const limited = (raw: unknown) => {
      const info = rateInfo(raw);
      blocked.current = true;
      h.current.rate?.(info);
      if (info.retryAfterSec) {
        until.current = Math.max(
          until.current,
          Date.now() + info.retryAfterSec * 1000,
        );
        setRemaining(Math.ceil((until.current - Date.now()) / 1000));
        try {
          localStorage.setItem(
            "nexus.live.cooldown",
            JSON.stringify({ until: until.current }),
          );
        } catch {}
      }
    };
    async function connect() {
      if (done || document.hidden) return;
      if (blocked.current || Date.now() < until.current) {
        status("RATE_LIMITED");
        return;
      }
      last = 0;
      id = "";
      healthy = false;
      reason = "";
      status("CONNECTING");
      try {
        const r = await fetch(
          `/api/live/preflight?symbol=${symbol}&interval=${interval}`,
          {
            method: "POST",
            credentials: "same-origin",
            signal: AbortSignal.timeout(20000),
            cache: "no-store",
          },
        );
        const value = await r.json();
        if (done || document.hidden) return;
        if (!r.ok || value.ready !== true) {
          reason = preflightCode(value.code);
          if (
            r.status === 429 ||
            reason === "RATE_LIMITED" ||
            reason === "CONNECTION_QUOTA"
          )
            limited(value);
          status(reason);
          return;
        }
      } catch {
        if (!done) status("BOOTSTRAP_FAILED");
        return;
      }
      if (done || document.hidden) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/live?symbol=${symbol}&interval=${interval}`,
      );
      socket.onmessage = (e) => {
        try {
          const raw = JSON.parse(e.data);
          if (raw.type === "basis") {
            const p = z
              .object({
                connectionId: z.uuid(),
                symbol: z.literal(symbol),
                interval: z.literal(interval),
                candles: z
                  .array(
                    z.object({
                      time: z.number(),
                      open: z.number(),
                      high: z.number(),
                      low: z.number(),
                      close: z.number(),
                    }),
                  )
                  .max(180),
              })
              .parse(raw);
            validateBars(p.candles, interval);
            id = p.connectionId;
            h.current.basis(id, p.candles);
            status("WAITING_FOR_BROKER_TICK");
          } else if (raw.type === "tick" && id) {
            const t = acceptTick(raw, id, symbol, last);
            if (t) {
              last = t.time;
              healthy = true;
              h.current.tick(t);
              status("EXNESS_LIVE");
            }
          } else if (raw.type === "status") {
            healthy = false;
            reason = String(raw.code);
            if (reason === "RATE_LIMITED" || reason === "CONNECTION_QUOTA")
              limited(raw);
            status(
              [
                "MAX_DURATION",
                "DISCONNECTED",
                "RATE_LIMITED",
                "EXNESS_PERMISSION",
                "EXNESS_PERMISSION_OR_UNAVAILABLE",
                "EXNESS_NETWORK",
                "EXNESS_UNAVAILABLE",
                "AUTH_REVOKED",
                ...preflightCodes,
              ].includes(reason)
                ? reason
                : "UNAVAILABLE",
            );
          }
        } catch {
          status("INVALID_STREAM");
          reason = "INVALID_STREAM";
          socket?.close();
        }
      };
      socket.onclose = () => {
        healthy = false;
        status(reason || "WEBSOCKET_UPGRADE_FAILED");
        if (
          !done &&
          !document.hidden &&
          ["MAX_DURATION", "DISCONNECTED"].includes(reason) &&
          attempt < 3
        ) {
          timer = setTimeout(connect, reconnectDelay(attempt++));
        }
      };
      socket.onerror = () => {
        healthy = false;
        status("WEBSOCKET_UPGRADE_FAILED");
      };
    }
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) {
        reason = "HIDDEN";
        socket?.close();
        status("HIDDEN");
      } else connect();
    };
    const watch = setInterval(() => {
      until.current = Math.max(until.current, saved());
      setRemaining(Math.max(0, Math.ceil((until.current - Date.now()) / 1000)));
      if (healthy && Date.now() - last > 10000) {
        healthy = false;
        status("STALE");
      }
    }, 500);
    document.addEventListener("visibilitychange", visibility);
    connect();
    return () => {
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      document.removeEventListener("visibilitychange", visibility);
      socket?.close();
    };
  }, [enabled, symbol, interval, epoch]);
  return remaining;
}
