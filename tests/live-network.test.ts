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
    internalCode: "NETWORK_ERROR",
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
