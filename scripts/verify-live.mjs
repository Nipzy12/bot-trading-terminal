import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor() {
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
  let polling = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/account/market")) polling++;
  });
  await page.goto("http://localhost:5173/?feed=live");
  await page.waitForFunction(() => window.sockets.length > 0);
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
    window.sockets
      .at(-1)
      .emit({
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
  await page.evaluate(() =>
    window.sockets.at(-1).emit({ type: "status", code: "RATE_LIMITED" }),
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
