import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) {
        this.url = url;
        window.sockets.push(this);
      }
      close() {
        this.onclose?.();
      }
      emit(v) {
        this.onmessage?.({ data: JSON.stringify(v) });
      }
    };
  });
  await page.route("**/api/live/preflight?**", (r) =>
    r.fulfill({
      json: { ready: true, code: "READY", brokerLiveVerified: false },
    }),
  );
  let polling = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/account/market")) polling++;
  });
  await page.goto("http://localhost:5173/?feed=live");
  await page.waitForFunction(() => window.sockets.length > 0);
  await page.evaluate(() =>
    window.sockets.at(-1).emit({ type: "status", code: "EXNESS_LIVE" }),
  );
  assert.equal(
    await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
    true,
  );
  assert.notEqual(
    await page.locator(".exchange").textContent(),
    "EXNESS · LIVE",
  );
  for (const code of [
    "WS_CONNECTED",
    "SUBSCRIPTION_SENT",
    "WAITING_FOR_BROKER_TICK",
  ]) {
    await page.evaluate(
      (code) =>
        window.sockets.at(-1).emit({
          type: "status",
          code,
          phase: "OPEN",
          upstreamOpened: true,
          subscriptionSent: code !== "WS_CONNECTED",
          subscriptionAckReceived: false,
          firstValidTickReceived: false,
        }),
      code,
    );
    await page.getByRole("status").filter({ hasText: code }).waitFor();
    await page
      .locator(".live-diagnostic")
      .filter({ hasText: "phase=OPEN" })
      .waitFor();
    assert.match(
      await page.locator(".live-diagnostic").textContent(),
      /firstValidTickReceived=false/,
    );
    assert.equal(
      await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
      true,
    );
    assert.notEqual(
      await page.locator(".exchange").textContent(),
      "EXNESS · LIVE",
    );
  }
  await page.evaluate(() =>
    window.sockets.at(-1).emit({
      type: "status",
      code: "UNKNOWN_BROKER_RESPONSE",
      internalCode: "ACK_CONTRACT_UNVERIFIED",
      phase: "OPEN",
      upstreamOpened: true,
      subscriptionSent: true,
      subscriptionAckReceived: false,
      firstValidTickReceived: false,
      id: "DO_NOT_DISPLAY_PRIVATE_REQUEST_ID",
      error_message: "DO_NOT_DISPLAY_RAW_FRAME",
    }),
  );
  await page
    .getByRole("status")
    .filter({ hasText: "UNKNOWN_BROKER_RESPONSE" })
    .waitFor();
  assert.match(
    await page.locator(".live-diagnostic").textContent(),
    /subscriptionAckReceived=false/,
  );
  assert.equal(
    await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
    true,
  );
  assert.equal(
    (await page.locator("body").textContent()).includes("DO_NOT_DISPLAY"),
    false,
  );
  await page.evaluate(() => {
    const interval = 3600,
      end = Math.floor(Date.now() / 1000 / interval) * interval;
    const socket = window.sockets.at(-1);
    const connectionId = "11111111-1111-4111-8111-111111111111";
    socket.emit({
      type: "basis",
      connectionId,
      symbol: "XAUUSD",
      interval,
      candles: Array.from({ length: 180 }, (_, i) => ({
        time: end - (180 - i) * interval,
        open: 3900,
        high: 3901,
        low: 3899,
        close: 3900,
      })),
    });
    socket.emit({
      type: "tick",
      connectionId,
      symbol: "XAUUSD",
      time: Date.now(),
      bid: 3900,
      ask: 3901,
    });
  });
  await page.waitForFunction(
    () => document.querySelector(".exchange")?.textContent === "EXNESS · LIVE",
  );
  await page
    .locator("canvas")
    .first()
    .evaluate((el) => (window.originalCanvas = el));
  await page.evaluate(() =>
    window.sockets.at(-1).emit({
      type: "tick",
      connectionId: "11111111-1111-4111-8111-111111111111",
      symbol: "XAUUSD",
      time: Date.now() + 1,
      bid: 3902,
      ask: 3903,
    }),
  );
  assert.equal(
    await page
      .locator("canvas")
      .first()
      .evaluate((el) => el === window.originalCanvas),
    true,
  );
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  assert.equal(polling, 0);
  for (const [code, brokerErrorCode] of [
    ["EXNESS_PERMISSION", 1002],
    ["EXNESS_SUBSCRIPTION_INVALID", 3000],
    ["UNKNOWN_BROKER_RESPONSE", 987654321],
  ]) {
    await page.evaluate(
      ([code, brokerErrorCode]) =>
        window.sockets.at(-1).emit({
          type: "status",
          code,
          brokerErrorCode,
          phase: "OPEN",
          upstreamOpened: true,
          subscriptionSent: true,
          subscriptionAckReceived: false,
          firstValidTickReceived: false,
          id: "DO_NOT_DISPLAY_REQUEST_ID",
          error_message: "DO_NOT_DISPLAY_RAW_ERROR",
        }),
      [code, brokerErrorCode],
    );
    await page.getByRole("status").filter({ hasText: code }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
      true,
    );
    const text = await page.locator("body").textContent();
    assert.equal(text.includes("DO_NOT_DISPLAY"), false);
    if (brokerErrorCode === 987654321)
      assert.equal(text.includes("987654321"), false);
    else
      assert.equal(text.includes(`brokerErrorCode=${brokerErrorCode}`), true);
  }
  for (const code of [
    "DNS_FAILED",
    "TCP_CONNECT_FAILED",
    "TLS_FAILED",
    "WS_HANDSHAKE_TIMEOUT",
    "WS_HANDSHAKE_FAILED",
    "WS_HTTP_REJECTED",
    "WS_DISCONNECTED",
  ]) {
    await page.evaluate((code) => {
      const socket = window.sockets.at(-1);
      socket.emit({
        type: "status",
        code,
        internalCode: "ERR_TLS_CERT_ALTNAME_INVALID",
        httpStatus: 403,
        rawError: "DO_NOT_DISPLAY_PRIVATE",
        phase:
          code === "DNS_FAILED"
            ? "DNS"
            : code === "TCP_CONNECT_FAILED"
              ? "TCP"
              : code === "TLS_FAILED"
                ? "TLS"
                : code === "WS_DISCONNECTED"
                  ? "OPEN"
                  : "HANDSHAKE",
        upstreamOpened: code === "WS_DISCONNECTED",
        subscriptionSent: code === "WS_DISCONNECTED",
        firstValidTickReceived: false,
        closeCode: 1006,
      });
      socket.onclose?.();
    }, code);
    await page.getByRole("status").filter({ hasText: code }).waitFor();
    const diagnostics = page.locator(".live-diagnostic");
    assert.match(
      await diagnostics.textContent(),
      /firstValidTickReceived=false/,
    );
    assert.match(await diagnostics.textContent(), /closeCode=1006/);
    for (const width of [360, 390, 412]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    assert.equal(
      await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
      true,
    );
    assert.notEqual(
      await page.locator(".exchange").textContent(),
      "EXNESS · LIVE",
    );
    assert.equal(
      (await page.locator("body").textContent()).includes(
        "DO_NOT_DISPLAY_PRIVATE",
      ),
      false,
    );
  }
  await page.evaluate(() =>
    window.sockets.at(-1).emit({
      type: "status",
      code: "RATE_LIMITED",
      brokerErrorCode: 3015,
      phase: "OPEN",
      upstreamOpened: true,
      subscriptionSent: true,
      subscriptionAckReceived: false,
      firstValidTickReceived: false,
      rateLimitSource: "EXNESS_WS",
      retryAfterSec: 5,
    }),
  );
  assert.equal(
    await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
    true,
  );
  const reconnect = page.getByRole("button", {
    name: "Hubungkan ulang manual",
    exact: true,
  });
  assert.equal(await reconnect.isDisabled(), true);
  const socketsBefore = await page.evaluate(
    () => window.sockets.filter((s) => s.url.includes("/api/live?")).length,
  );
  const second = await page.context().newPage();
  let secondRequests = 0;
  second.on("request", (r) => {
    if (r.url().includes("/api/live/preflight")) secondRequests++;
  });
  await second.goto("http://localhost:5173/?feed=live");
  await second.waitForFunction(
    () => document.querySelector(".feed-warning button")?.disabled === true,
  );
  assert.equal(secondRequests, 0);
  await second.close();
  await page.waitForTimeout(5500);
  assert.equal(await reconnect.isDisabled(), false);
  assert.equal(
    await page.evaluate(
      () => window.sockets.filter((s) => s.url.includes("/api/live?")).length,
    ),
    socketsBefore,
  );

  await page.unroute("**/api/live/preflight?**");
  await page.route("**/api/live/preflight?**", (r) =>
    r.fulfill({
      status: 403,
      json: {
        ready: false,
        code: "ACCOUNT_TRADE_MODE_DISABLED",
        brokerLiveVerified: false,
      },
    }),
  );
  await page.reload();
  await page
    .getByRole("status")
    .filter({ hasText: "ACCOUNT_TRADE_MODE_DISABLED" })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => window.sockets.filter((s) => s.url.includes("/api/live?")).length,
    ),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: mocked LIVE ticks, chart canvas retained, no M5 REST polling, rate-limit stop, Android 360–412px. Not a real broker test.",
  );
} finally {
  await browser.close();
}
