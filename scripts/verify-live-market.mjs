import { workspacePage } from "./workspace-navigation.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
try {
  const page = await browser
      .newPage({ viewport: { width: 390, height: 844 } })
      .then(workspacePage),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let requests = 0,
    orders = 0;
  await page.addInitScript(() => {
    window.marketNow = Date.UTC(2026, 10, 3, 11, 59, 55);
    const OriginalDate = Date;
    window.Date = class extends OriginalDate {
      constructor(...args) {
        super(...(args.length ? args : [window.marketNow]));
      }
      static now() {
        return window.marketNow;
      }
    };
    window.marketSockets = [];
    window.WebSocket = class {
      constructor(url) {
        this.url = url;
        window.marketSockets.push(this);
      }
      close() {
        this.onclose?.();
      }
      emit(value) {
        this.onmessage?.({ data: JSON.stringify(value) });
      }
    };
  });
  await page.route("**/api/live/preflight?**", (r) => {
    requests++;
    return r.fulfill({
      json: { ready: true, code: "READY", brokerLiveVerified: false },
    });
  });
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/orders") orders++;
  });
  await page.goto("http://localhost:5173/?feed=live");
  await page.waitForFunction(() =>
    window.marketSockets.some((s) => s.url.includes("/api/live?")),
  );
  async function basis(connectionId = id) {
    await page.evaluate((connectionId) => {
      const end = Math.floor(Date.now() / 1000 / 3600) * 3600;
      const candles = Array.from({ length: 30 }, (_, i) => ({
        time: end - (30 - i) * 3600,
        open: 3900,
        high: 3901,
        low: 3898,
        close: i === 29 ? 3899 : 3900,
      }));
      window.marketSockets.at(-1).emit({
        type: "basis",
        connectionId,
        symbol: "XAUUSD",
        interval: 3600,
        candles,
      });
    }, connectionId);
  }
  async function tick(bid, ask, advance = 0, connectionId = id) {
    await page.evaluate(
      ({ bid, ask, advance, connectionId }) => {
        window.marketNow += advance;
        window.marketSockets.at(-1).emit({
          type: "tick",
          connectionId,
          symbol: "XAUUSD",
          time: Date.now(),
          timestampMs: Date.now(),
          bid,
          ask,
          provider: "EXNESS",
          source: "EXNESS_LIVE",
          freshness: "FRESH",
        });
      },
      { bid, ask, advance, connectionId },
    );
  }
  async function book() {
    return page.evaluate(() =>
      JSON.parse(localStorage.getItem("nexus.paper.v2")),
    );
  }
  const acct = (b) =>
    b.accounts.find(
      (a) => a.source.kind === "EXNESS_LIVE" && a.source.connectionId === id,
    );
  const buy = page.getByRole("button", { name: "Buy XAUUSD" });
  const robot = () =>
    page.getByRole("button", { name: "Jalankan robot simulasi", exact: true });
  await basis();
  await tick(3902, 3903);
  await page.waitForFunction(
    () => document.querySelector(".exchange")?.textContent === "EXNESS · LIVE",
  );
  const gold = page.locator(".watch-row").filter({ hasText: "XAUUSD" }),
    eur = page.locator(".watch-row").filter({ hasText: "EURUSD" });
  assert.match(await gold.textContent(), /3,902\.00 \/ 3,903\.00/);
  assert.match(await eur.textContent(), /NOT SUBSCRIBED/);
  assert.equal(
    (await page.locator(".watchlist").textContent()).includes("2,742"),
    false,
  );
  assert.equal(
    (await page.locator(".ticker").textContent()).includes("DEMO"),
    false,
  );
  assert.equal(
    (await page.locator(".watchlist").textContent()).includes("%"),
    false,
  );
  assert.match(
    await page.locator(".mode-labels").textContent(),
    /EXECUTION MODE: PAPER/,
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
  assert.equal(requests, 1);
  assert.equal(
    await page.evaluate(
      () =>
        window.marketSockets.filter((s) => s.url.includes("/api/live?")).length,
    ),
    1,
  );
  await robot().click();
  assert.equal(acct(await book()).positions.length, 0);
  await tick(3904, 3905, 6000); // First broker tick after UTC close: new Buy crossover.
  await page.waitForFunction(
    (id) =>
      JSON.parse(localStorage.getItem("nexus.paper.v2")).accounts.find(
        (a) => a.source.connectionId === id,
      )?.positions.length === 1,
    id,
  );
  assert.equal(acct(await book()).positions[0].entry, 3905);
  assert.equal(acct(await book()).positions[0].spreadCost, 1);
  assert.match(
    await page.locator(".autopilot-status").textContent(),
    /LIVE SIGNAL/,
  );
  await tick(3904, 3905, 1);
  await tick(3904, 3905, 1);
  assert.equal(acct(await book()).positions.length, 1);
  await page.getByRole("button", { name: "Sell / Short", exact: true }).click();
  await page.getByRole("button", { name: "Sell XAUUSD" }).click();
  await page.waitForFunction(
    (id) =>
      JSON.parse(localStorage.getItem("nexus.paper.v2")).accounts.find(
        (a) => a.source.connectionId === id,
      ).positions.length === 2,
    id,
  );
  assert.equal(
    acct(await book()).positions.find((p) => p.side === "Sell").entry,
    3904,
  );
  await tick(3906, 3907, 1);
  await page
    .locator(".trade-card")
    .filter({ hasText: "Sell · Terbuka" })
    .getByRole("button", { name: "Tutup", exact: true })
    .click();
  await page
    .locator(".trade-card")
    .filter({ hasText: "Buy · Terbuka" })
    .getByRole("button", { name: "Tutup", exact: true })
    .click();
  let a = acct(await book());
  assert.equal(a.positions.length, 0);
  assert.equal(a.history.find((h) => h.side === "Sell").exit, 3907);
  assert.equal(a.history.find((h) => h.side === "Sell").pnl, -3);
  assert.equal(a.history.find((h) => h.side === "Buy").exit, 3906);
  assert.equal(a.history.find((h) => h.side === "Buy").pnl, 1);
  await tick(3906, 3907, 1);
  assert.equal(acct(await book()).positions.length, 0); // Same signal remains consumed after closing.
  await page.getByRole("button", { name: "Buy / Long", exact: true }).click();
  for (let i = 0; i < 3; i++) {
    await buy.click();
    await page.waitForFunction(
      ({ id, n }) =>
        JSON.parse(localStorage.getItem("nexus.paper.v2")).accounts.find(
          (a) => a.source.connectionId === id,
        ).positions.length === n,
      { id, n: i + 1 },
    );
  }
  assert.equal(await buy.isDisabled(), true);
  await page
    .getByRole("button", { name: "Emergency stop · tutup semua", exact: true })
    .click();
  await page.waitForFunction(
    (id) =>
      JSON.parse(localStorage.getItem("nexus.paper.v2")).accounts.find(
        (a) => a.source.connectionId === id,
      ).positions.length === 0,
    id,
  );
  a = acct(await book());
  assert.equal(a.history.filter((h) => h.reason === "Emergency").length, 3);
  assert.equal(
    a.history
      .filter((h) => h.reason === "Emergency")
      .every((h) => h.exit === 3906 && h.pnl === -1),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", {
      name: "Buka kunci manual (robot tetap berhenti)",
      exact: true,
    })
    .click();
  await buy.click();
  await robot().click();
  await page.evaluate(() => (window.marketNow += 11000));
  await page
    .getByRole("status")
    .filter({ hasText: "EXNESS LIVE · Quote kedaluwarsa" })
    .waitFor();
  assert.match(await gold.textContent(), /STALE/);
  assert.match(await page.locator(".autopilot-status").textContent(), /STALE/);
  assert.equal(await buy.isDisabled(), true);
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  assert.match(await page.locator(".pnl-strip").textContent(), /Menunggu/);
  await page
    .getByRole("button", { name: "Emergency stop · tutup semua", exact: true })
    .click();
  assert.equal(acct(await book()).positions.length, 1);
  await tick(3908, 3909, 1);
  await page.waitForFunction(
    (id) =>
      JSON.parse(localStorage.getItem("nexus.paper.v2")).accounts.find(
        (a) => a.source.connectionId === id,
      ).positions.length === 0,
    id,
  );
  assert.equal(acct(await book()).history[0].exit, 3908);
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", {
      name: "Buka kunci manual (robot tetap berhenti)",
      exact: true,
    })
    .click();
  await buy.click();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("nexus-account-change")),
  );
  await page
    .getByRole("status")
    .filter({ hasText: "ACCOUNT_CHANGED" })
    .waitFor();
  await tick(9000, 9001, 1);
  assert.notEqual(
    await page.locator(".exchange").textContent(),
    "EXNESS · LIVE",
  );
  assert.equal(acct(await book()).positions.length, 1);
  await page
    .getByRole("button", { name: "Hubungkan ulang manual", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.marketSockets.filter((s) => s.url.includes("/api/live?"))
        .length === 2,
  );
  await basis(other);
  await tick(4000, 4001, 1, other);
  await page.locator("#paper-account").selectOption(`EXNESS_LIVE:${id}`);
  assert.equal(await buy.isDisabled(), true);
  assert.match(await page.locator(".pnl-strip").textContent(), /Menunggu/);
  assert.equal(acct(await book()).positions.length, 1);
  await page.locator("#paper-account").selectOption(`EXNESS_LIVE:${other}`);
  await robot().click();
  await page.evaluate(() =>
    window.marketSockets.at(-1).emit({
      type: "status",
      code: "RATE_LIMITED",
      brokerErrorCode: 3015,
      rateLimitSource: "EXNESS_WS",
      retryAfterSec: 5,
    }),
  );
  await page.getByRole("status").filter({ hasText: "RATE_LIMITED" }).waitFor();
  await tick(9000, 9001, 1, other);
  assert.notEqual(
    await page.locator(".exchange").textContent(),
    "EXNESS · LIVE",
  );
  assert.equal(await buy.isDisabled(), true);
  await page.evaluate(() => (window.marketNow += 6000));
  await page.waitForTimeout(700);
  assert.equal(
    await page.evaluate(
      () =>
        window.marketSockets.filter((s) => s.url.includes("/api/live?")).length,
    ),
    2,
  );
  assert.equal(requests, 2);
  assert.equal(orders, 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: one-stream market store, truthful watchlist/ticker, closed SMA20 crossover/no duplicates, two-sided PAPER fills/P&L, max three/emergency/stale, connection isolation, no 429 retry, Android 360–412px. Broker data is mocked.",
  );
} finally {
  await browser.close();
}
