import { preflightCode, preflightCodes } from "./live-diagnostics";
import { useEffect, useRef } from "react";
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
  },
) {
  const h = useRef(handlers);
  h.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | undefined,
      done = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      last = 0,
      id = "",
      attempt = 0,
      reason = "",
      healthy = false;
    const status = (s: string) => h.current.status(s);
    async function connect() {
      if (done || document.hidden) return;
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
        if (!reason && !done && !document.hidden) {
          void fetch(
            `/api/live/preflight?symbol=${symbol}&interval=${interval}`,
            {
              method: "POST",
              credentials: "same-origin",
              signal: AbortSignal.timeout(20000),
              cache: "no-store",
            },
          )
            .then(async (r) => {
              const v = await r.json();
              if (!done)
                status(
                  r.ok && v.ready === true
                    ? "WEBSOCKET_UPGRADE_FAILED"
                    : preflightCode(v.code),
                );
            })
            .catch(() => {
              if (!done) status("WEBSOCKET_UPGRADE_FAILED");
            });
        }
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
}
