import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const base = process.env.BASE_URL || "http://localhost:5173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(15000);
  const legacy = {
    version: 1,
    positions: Array.from({ length: 3 }, (_, i) => ({
      id: `legacy-${i}`,
      symbol: "XAUUSD",
      side: "Buy",
      size: 0.01,
      entry: 2740,
      sl: 2700,
      tp: 2800,
      openedAt: Date.now() - 86400000,
    })),
    history: [],
    dailyLimit: 100,
    haltDay: "",
    emergency: false,
  };
  await page.addInitScript((raw) => {
    if (!localStorage.getItem("nexus.paper.v1"))
      localStorage.setItem("nexus.paper.v1", raw);
  }, JSON.stringify(legacy));
  let selected = 0;
  const privateFeed = async (route) => {
    const interval = Number(
      new URL(route.request().url()).searchParams.get("interval"),
    );
    const end = Math.floor(Date.now() / 1000 / interval) * interval;
    const price = selected === 0 ? 3899 : 4000;
    await route.fulfill({
      json: {
        source: "exness",
        paperSource: { kind: "EXNESS", connectionId: ids[selected] },
        label: "EXNESS",
        kind: "candle-history",
        live: false,
        candles: Array.from({ length: 180 }, (_, i) => ({
          time: end - (180 - i) * interval,
          open: price,
          high: price + 1,
          low: price - 1,
          close: price,
        })),
      },
    });
  };
  await page.route("**/api/account/market?**", privateFeed);
  const book = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("nexus.paper.v2")));
  const ready = () =>
    page.waitForFunction(
      () => document.querySelector(".submit-order")?.disabled === false,
    );
  await page.goto(base + "/?feed=exness");
  await ready();
  assert.equal((await book()).accounts[0].positions.length, 3);
  assert.match(await page.locator(".order-details").innerText(), /3,899/);
  await page.getByRole("button", { name: "Buy XAUUSD" }).click();
  await page.locator(".trade-card").waitFor();
  let stored = await book();
  assert.equal(stored.accounts[1].positions[0].entry, 3899);
  assert.equal(stored.accounts[0].positions.length, 3);
  assert.match(await page.locator(".pnl-strip").innerText(), /\$0.00/);
  await page
    .getByRole("button", { name: "Jalankan robot simulasi", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Hentikan robot", exact: true })
    .waitFor();
  await page.getByLabel("Akun paper terpisah").selectOption("DEMO");
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.locator(".trade-card").count(), 3);
  assert.match(await page.locator(".pnl-strip").innerText(), /Menunggu/);
  assert.equal(
    await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
    true,
  );
  for (const button of await page
    .getByRole("button", { name: "Tutup", exact: true })
    .all())
    assert.equal(await button.isDisabled(), true);
  await page.screenshot({
    path: "/workspace/paper-source-mismatch-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("Akun paper terpisah").selectOption(`EXNESS:${ids[0]}`);
  await page
    .getByRole("button", { name: "Emergency stop · tutup semua", exact: true })
    .click();
  await page.getByRole("button", { name: "Riwayat 1", exact: true }).click();
  assert.match(await page.locator(".trade-card").innerText(), /Emergency/);
  stored = await book();
  assert.equal(stored.accounts[0].emergency, false);
  assert.equal(stored.accounts[0].positions.length, 3);
  selected = 1;
  await page
    .getByText(
      "Koneksi feed berubah. Muat ulang chart; akun paper lama tetap tersimpan.",
      { exact: true },
    )
    .waitFor({ timeout: 12000 });
  assert.equal(
    await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
    true,
  );
  await page.reload();
  await ready();
  assert.equal((await book()).accounts.length, 3);
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Buy XAUUSD" }).click();
  await page.locator(".trade-card").waitFor();
  stored = await book();
  assert.equal(stored.accounts[2].positions[0].entry, 4000);
  assert.equal(stored.accounts[1].history.length, 1);
  await page.getByRole("link", { name: "Feed DEMO", exact: true }).click();
  await ready();
  assert.equal(await page.locator(".trade-card").count(), 3);
  stored = await book();
  assert.equal(stored.accounts[0].history.length, 0);
  for (const p of stored.accounts[0].positions) {
    assert.equal(p.entry, 2740);
    assert.equal(p.accountKey, "DEMO");
    assert.equal(p.tp, 2800);
  }
  assert.match(await page.locator(".watchlist h2").innerText(), /DEMO/);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("nexus.paper.v1")),
    JSON.stringify(legacy),
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: "/workspace/paper-accounts-desktop.png",
    fullPage: true,
  });
  const pendingPage = await browser.newPage({
    viewport: { width: 360, height: 844 },
  });
  pendingPage.on("pageerror", (e) => errors.push(e.message));
  await pendingPage.addInitScript(
    (raw) => localStorage.setItem("nexus.paper.v1", raw),
    JSON.stringify(legacy),
  );
  await pendingPage.route("**/api/account/market?**", privateFeed);
  await pendingPage.goto(base + "/?feed=exness");
  await pendingPage.waitForFunction(
    () => document.querySelector(".submit-order")?.disabled === false,
  );
  await pendingPage.getByLabel("Akun paper terpisah").selectOption("DEMO");
  await pendingPage
    .getByRole("button", { name: "Emergency stop · tutup semua", exact: true })
    .click();
  await pendingPage.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("nexus.paper.v2")).accounts[0]
        .emergency === true,
  );
  const queued = await pendingPage.evaluate(
    () => JSON.parse(localStorage.getItem("nexus.paper.v2")).accounts[0],
  );
  assert.equal(queued.positions.length, 3);
  assert.equal(queued.history.length, 0);
  assert.match(await pendingPage.locator(".pnl-strip").innerText(), /Menunggu/);
  assert.equal(
    await pendingPage
      .getByRole("button", { name: "Jalankan robot simulasi", exact: true })
      .isDisabled(),
    true,
  );
  await pendingPage.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: legacy DEMO positions preserved; Exness connection A/B entries, marks, pending mismatch, emergency/history isolation, reload and mobile UI; legacy backup unchanged.",
  );
} finally {
  await browser.close();
}
