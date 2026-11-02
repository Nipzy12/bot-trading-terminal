import { expect, it } from "vitest";
import { networkFailure } from "../server/live-network";
import { streamStatusLabel } from "../src/live-diagnostics";
it("never serializes nested or aggregate raw network errors", () => {
  const e = Object.assign(new Error("secret"), {
    errors: [{ code: "ENOTFOUND", address: "secret" }],
    cause: { code: "ECONNREFUSED", host: "secret" },
  });
  expect(networkFailure(e, "TCP")).toEqual({
    stage: "TCP_CONNECT_FAILED",
    internalCode: "TCP_ERROR_NO_CODE",
  });
  expect(
    streamStatusLabel("WS_HTTP_REJECTED", {
      stage: "PRIVATE",
      httpStatus: 403,
      internalCode: "PRIVATE",
      raw: "secret",
    }),
  ).toBe("WS_HTTP_REJECTED · HTTP 403");
  expect(
    streamStatusLabel("RATE_LIMITED", {
      stage: "WS_HTTP_REJECTED",
      httpStatus: 429,
      internalCode: "HTTP_REJECTED",
    }),
  ).toBe("RATE_LIMITED · WS_HTTP_REJECTED · HTTP 429 · HTTP_REJECTED");
});

it("filters diagnostics and observability using enums only", async () => {
  const { liveDiagnostic } = await import("../src/live-diagnostics"),
    { observeLive } = await import("../server/live-network"),
    { vi } = await import("vitest");
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const raw = {
      phase: "OPEN",
      upstreamOpened: true,
      subscriptionSent: false,
      subscriptionAckReceived: false,
      firstValidTickReceived: false,
      closeCode: 4999,
      internalCode: "PRIVATE_ACCOUNT",
      host: "private",
      headers: { secret: "secret" },
      message: "raw exception",
    };
    expect(liveDiagnostic(raw)).toEqual({
      phase: "OPEN",
      upstreamOpened: true,
      subscriptionSent: false,
      subscriptionAckReceived: false,
      firstValidTickReceived: false,
    });
    observeLive("PRIVATE_HOST", raw);
    expect(JSON.parse(spy.mock.calls[0][0])).toEqual({
      event: "nexus.live",
      stage: "UNAVAILABLE",
      phase: "OPEN",
      upstreamOpened: true,
      subscriptionSent: false,
      subscriptionAckReceived: false,
      firstValidTickReceived: false,
    });
    expect(liveDiagnostic({ ...raw, phase: "PRIVATE_HOST" })).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});
