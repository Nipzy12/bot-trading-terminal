// Real ws + Node TLS against a local synthetic server; never connects to Exness.
import { afterAll, beforeAll, expect, it } from "vitest";
import https from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  EXNESS_WS_PROTOCOL,
  networkFailure,
  pinnedTlsOptions,
  type NetworkPhase,
} from "../server/live-network";
let directory: string,
  certificate: Buffer,
  server: https.Server,
  wss: WebSocketServer,
  port: number;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "nexus-synthetic-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=fixture.exness.test",
      "-addext",
      "subjectAltName=DNS:fixture.exness.test",
    ],
    { stdio: "ignore" },
  );
  certificate = readFileSync(join(directory, "cert.pem"));
  server = https.createServer({
    key: readFileSync(join(directory, "key.pem")),
    cert: certificate,
  });
  wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(EXNESS_WS_PROTOCOL) ? EXNESS_WS_PROTOCOL : false,
  });
  // Reproduce ws's code-less rejection of an unsolicited server subprotocol.
  wss.on("headers", (headers, req) => {
    if (!req.headers["sec-websocket-protocol"])
      headers.push(`Sec-WebSocket-Protocol: ${EXNESS_WS_PROTOCOL}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as import("node:net").AddressInfo).port;
});
afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(directory, { recursive: true, force: true });
});
function connect(
  protocol: boolean,
  trust = true,
  host = "fixture.exness.test",
) {
  const phases: NetworkPhase[] = [];
  const options = {
    ...pinnedTlsOptions(host, [{ address: "127.0.0.1", family: 4 }], (p) =>
      phases.push(p),
    ),
    ...(trust ? { ca: certificate } : {}),
    handshakeTimeout: 1000,
    perMessageDeflate: false,
    followRedirects: false,
  };
  const url = `wss://${host}:${port}/v1/server-events/accounts/123456/ws/ticks`;
  return {
    socket: protocol
      ? new WebSocket(url, EXNESS_WS_PROTOCOL, options)
      : new WebSocket(url, options),
    phases,
  };
}
it("negotiates the official subprotocol using real ws/TLS, pinned DNS, port and verified SNI", async () => {
  const { socket, phases } = connect(true);
  const request = once(wss, "connection");
  await once(socket, "open");
  const [up, req] = await request;
  expect(req.url).toBe("/v1/server-events/accounts/123456/ws/ticks");
  expect(req.headers["sec-websocket-protocol"]).toBe(EXNESS_WS_PROTOCOL);
  expect(req.headers["sec-websocket-extensions"]).toBeUndefined();
  expect(req.socket.servername).toBe("fixture.exness.test");
  expect(phases).toEqual(["TLS", "HANDSHAKE"]);
  expect(socket.protocol).toBe(EXNESS_WS_PROTOCOL);
  const ended = once(socket, "close");
  up.close(1000);
  await ended;
});
it("reproduces a code-less handshake error when server subprotocol was not requested", async () => {
  const { socket, phases } = connect(false);
  const [error] = await once(socket, "error");
  expect(error.code).toBeUndefined();
  expect(phases.at(-1)).toBe("HANDSHAKE");
  expect(networkFailure(error, "HANDSHAKE")).toEqual({
    stage: "WS_HANDSHAKE_FAILED",
    internalCode: "WS_HANDSHAKE_ERROR_NO_CODE",
  });
  socket.terminate();
});
it.each([
  [false, "fixture.exness.test"],
  [true, "wrong.exness.test"],
] as const)(
  "does not bypass trust or SNI hostname verification (%s %s)",
  async (trust, host) => {
    const { socket, phases } = connect(true, trust, host);
    const [error] = await once(socket, "error");
    expect(networkFailure(error, "TLS").stage).toBe("TLS_FAILED");
    expect(phases).not.toContain("HANDSHAKE");
    socket.terminate();
  },
);
