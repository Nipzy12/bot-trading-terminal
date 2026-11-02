import {
  brokerStatuses,
  liveDiagnostic,
  type LiveDiagnostic,
  networkStages,
  streamStatusLabel,
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
    diagnostic?: (d: LiveDiagnostic | undefined) => void;
    clock?: (now: number) => void;
    begin?: () => void;
  },
) {
  const until = useRef(0),
    blocked = useRef(false),
    lastEpoch = useRef(epoch);
  const [remaining, setRemaining] = useState(0);
  const h = useRef(handlers);
  h.current = handlers;
  const scope = useRef({ enabled, symbol, interval, epoch });
  scope.current = { enabled, symbol, interval, epoch };
  useEffect(() => {
    if (!enabled) return;
    if (lastEpoch.current !== epoch) {
      lastEpoch.current = epoch;
      if (Date.now() >= until.current) blocked.current = false;
    }
    let preflight: AbortController | undefined;
    let socket: WebSocket | undefined,
      done = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      last = 0,
      id = "",
      attempt = 0,
      reason = "",
      reasonLabel = "",
      healthy = false,
      upstreamOpened = false,
      accountChanged = false,
      terminal = false,
      generation = 0;
    const currentScope = () =>
      scope.current.enabled &&
      scope.current.symbol === symbol &&
      scope.current.interval === interval &&
      scope.current.epoch === epoch;
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
      if (done || document.hidden || accountChanged || !currentScope()) return;
      if (blocked.current || Date.now() < until.current) {
        status("RATE_LIMITED");
        return;
      }
      const attemptGeneration = ++generation;
      preflight?.abort();
      preflight = new AbortController();
      terminal = false;
      last = 0;
      id = "";
      healthy = false;
      reason = "";
      reasonLabel = "";
      upstreamOpened = false;
      h.current.diagnostic?.(undefined);
      h.current.begin?.();
      status("CONNECTING");
      try {
        const r = await fetch(
          `/api/live/preflight?symbol=${symbol}&interval=${interval}`,
          {
            method: "POST",
            credentials: "same-origin",
            signal: AbortSignal.any([
              preflight.signal,
              AbortSignal.timeout(20000),
            ]),
            cache: "no-store",
          },
        );
        const value = await r.json();
        if (
          done ||
          document.hidden ||
          accountChanged ||
          !currentScope() ||
          attemptGeneration !== generation
        )
          return;
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
        if (!done && !accountChanged && attemptGeneration === generation)
          status("BOOTSTRAP_FAILED");
        return;
      }
      if (
        done ||
        document.hidden ||
        accountChanged ||
        attemptGeneration !== generation ||
        !currentScope()
      )
        return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/live?symbol=${symbol}&interval=${interval}`,
      );
      socket.onmessage = (e) => {
        if (
          terminal ||
          done ||
          accountChanged ||
          document.hidden ||
          attemptGeneration !== generation ||
          !currentScope()
        )
          return;
        try {
          const raw = JSON.parse(e.data);
          if (raw.type === "status" && raw.code === "EXNESS_LIVE") return;
          if (raw.type === "status" || raw.type === "diagnostic")
            h.current.diagnostic?.(liveDiagnostic(raw));
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
            status("CONNECTING");
          } else if (raw.type === "tick" && id) {
            const t = acceptTick(raw, id, symbol, last);
            if (t) {
              last = t.time;
              healthy = true;
              upstreamOpened = true;
              reason = "";
              reasonLabel = "";
              h.current.tick(t);
              status("EXNESS_LIVE");
            }
          } else if (raw.type === "status") {
            healthy = false;
            upstreamOpened ||= raw.upstreamOpened === true;
            reason = String(raw.code);
            if (reason === "RATE_LIMITED" || reason === "CONNECTION_QUOTA")
              limited(raw);
            const safeCode = [
              "MAX_DURATION",
              "DISCONNECTED",
              "RATE_LIMITED",
              "EXNESS_PERMISSION",
              "EXNESS_PERMISSION_OR_UNAVAILABLE",
              "EXNESS_NETWORK",
              "EXNESS_UNAVAILABLE",
              "AUTH_REVOKED",
              "ACCOUNT_CHANGED",
              ...preflightCodes,
              ...brokerStatuses,
              ...networkStages.filter((code) => code !== "EXNESS_LIVE"),
            ].includes(reason)
              ? reason
              : "UNAVAILABLE";
            const progress = [
              "WS_CONNECTED",
              "SUBSCRIPTION_SENT",
              "WAITING_FOR_BROKER_TICK",
            ].includes(safeCode);
            const candidate =
              safeCode === "UNKNOWN_BROKER_RESPONSE" &&
              raw.internalCode === "ACK_CONTRACT_UNVERIFIED";
            terminal = !progress && !candidate;
            reasonLabel = streamStatusLabel(safeCode, raw);
            status(reasonLabel);
          }
        } catch {
          status("INVALID_STREAM");
          reason = "INVALID_STREAM";
          socket?.close();
        }
      };
      socket.onclose = () => {
        if (
          done ||
          accountChanged ||
          attemptGeneration !== generation ||
          !currentScope()
        )
          return;
        terminal = true;
        healthy = false;
        if (
          [
            "WS_CONNECTED",
            "SUBSCRIPTION_SENT",
            "WAITING_FOR_BROKER_TICK",
          ].includes(reason) ||
          (!reason && upstreamOpened)
        ) {
          reason = "WS_DISCONNECTED";
          reasonLabel = "WS_DISCONNECTED";
        }
        status(reasonLabel || reason || "WEBSOCKET_UPGRADE_FAILED");
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
        if (
          done ||
          accountChanged ||
          attemptGeneration !== generation ||
          !currentScope()
        )
          return;
        healthy = false;
        terminal = true;
        status(reasonLabel || reason || "WEBSOCKET_UPGRADE_FAILED");
      };
    }
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) {
        generation++;
        preflight?.abort();
        healthy = false;
        reason = "HIDDEN";
        socket?.close();
        status("HIDDEN");
      } else connect();
    };
    const changed = () => {
      if (accountChanged) return;
      accountChanged = true;
      generation++;
      preflight?.abort();
      healthy = false;
      clearTimeout(timer);
      socket?.close();
      status("ACCOUNT_CHANGED");
    };
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("nexus-account-change")
        : null;
    channel?.addEventListener("message", changed);
    window.addEventListener("nexus-account-change", changed);
    const watch = setInterval(() => {
      if (!currentScope() || done) return;
      h.current.clock?.(Date.now());
      until.current = Math.max(until.current, saved());
      setRemaining(Math.max(0, Math.ceil((until.current - Date.now()) / 1000)));
      if (healthy && Date.now() - last > 10000) {
        healthy = false;
        status("STALE");
      }
    }, 500);
    document.addEventListener("visibilitychange", visibility);
    // React Strict Mode can replay setup/cleanup before this microtask. Avoid
    // starting a preflight for an effect that has already been disposed.
    void Promise.resolve().then(connect);
    return () => {
      done = true;
      preflight?.abort();
      clearTimeout(timer);
      clearInterval(watch);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("nexus-account-change", changed);
      channel?.close();
      socket?.close();
    };
  }, [enabled, symbol, interval, epoch]);
  return remaining;
}
