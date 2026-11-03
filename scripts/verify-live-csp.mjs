import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const config = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
);
const policy = config.routes[0].headers["Content-Security-Policy"],
  connect = policy.split(";").find((s) => s.trim().startsWith("connect-src"));
assert.equal(
  connect.trim(),
  "connect-src 'self' wss://bot-trading-terminal.vercel.app https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.firebaseapp.com",
);
assert.equal(config.routes[1].dest, "/api/live.ts");
let address = "",
  upgrades = 0;
const server = http.createServer((_req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    policy.replace("wss://bot-trading-terminal.vercel.app", address),
  );
  res.end("<!doctype html><title>WebSocket CSP test</title>");
});
const wss = new WebSocketServer({ server });
wss.on("connection", (s) => {
  upgrades++;
  s.send(JSON.stringify({ type: "mock", brokerLiveVerified: false }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
address = `ws://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`http://127.0.0.1:${port}`);
    const result = await page.evaluate(
      async (url) =>
        new Promise((resolve) => {
          const ws = new WebSocket(url);
          ws.onmessage = (e) => {
            resolve(JSON.parse(e.data));
            ws.close();
          };
          ws.onerror = () => resolve({ failed: true });
        }),
      address,
    );
    assert.equal(result.brokerLiveVerified, false);
    assert.equal(result.failed, undefined);
  }
  const blocked = await page.evaluate(
    async () =>
      new Promise((resolve) => {
        document.addEventListener(
          "securitypolicyviolation",
          (e) => resolve(e.violatedDirective),
          { once: true },
        );
        new WebSocket("wss://untrusted.invalid/socket");
      }),
  );
  assert.equal(blocked, "connect-src");
  assert.equal(upgrades, 3);
  console.log(
    "PASS: real Chromium WebSocket HTTP 101 under explicit trusted-origin CSP, foreign socket blocked, widths 360/390/412. Local mock server, not Exness.",
  );
} finally {
  await browser.close();
  wss.close();
  await new Promise((r) => server.close(r));
}
