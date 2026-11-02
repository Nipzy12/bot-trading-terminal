import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const base = process.env.BASE_URL || "http://localhost:5173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/backtest", { waitUntil: "domcontentloaded" });
  const original = {
    version: 1,
    positions: [
      {
        id: "legacy",
        symbol: "XAUUSD",
        side: "Buy",
        size: 0.01,
        entry: 2740,
        openedAt: 1700000000000,
      },
    ],
    history: [],
    dailyLimit: 100,
    haltDay: "",
    emergency: false,
  };
  await page.evaluate((raw) => {
    localStorage.setItem("nexus.paper.v1", raw);
    localStorage.setItem("nexus.paper.v2", JSON.stringify({ untouched: true }));
  }, JSON.stringify(original));
  const before = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  await page
    .getByRole("button", { name: "Jalankan backtest", exact: true })
    .click();
  await page.getByRole("region", { name: "Laporan backtest" }).waitFor();
  assert.equal(await page.locator(".bt-report").count(), 2);
  assert.match(await page.locator(".bt-result-heading").innerText(), /DEMO/);
  assert.equal(await page.locator(".equity-chart svg").count(), 2);
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
    before,
  );
  await page.screenshot({
    path: "/workspace/backtest-desktop.png",
    fullPage: true,
  });
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `Backtest overflow ${width}`,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Jalankan backtest", exact: true })
        .isVisible(),
      true,
    );
  }
  await page.screenshot({
    path: "/workspace/backtest-mobile.png",
    fullPage: true,
  });
  let requests = 0,
    fault = null;
  await page.route("**/api/account/backtest/history?**", async (route) => {
    requests++;
    const u = new URL(route.request().url());
    if (fault && Number(u.searchParams.get("pageIndex")) === 5) {
      await route.fulfill({
        status: 400,
        json: {
          error: fault.category,
          providerCode: fault.code,
          upstreamStatus: 400,
          message: "private-host-account-price-must-not-display",
          paperSource: {
            kind: "EXNESS",
            connectionId: "11111111-1111-4111-8111-111111111111",
          },
        },
      });
      return;
    }
    const r = await page.request.get(
      base + "/api/backtest/history?" + u.searchParams,
    );
    const payload = await r.json();
    await route.fulfill({
      json: {
        ...payload,
        source: "exness",
        label: "EXNESS",
        kind: "candle-history",
        live: false,
        paperSource: {
          kind: "EXNESS",
          connectionId: "11111111-1111-4111-8111-111111111111",
        },
      },
    });
  });
  await page.getByLabel("Sumber data", { exact: true }).selectOption("EXNESS");
  assert.equal(
    await page.getByRole("region", { name: "Laporan backtest" }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Jalankan backtest", exact: true })
    .click();
  await page.getByRole("region", { name: "Laporan backtest" }).waitFor();
  assert.equal(requests, 4);
  assert.match(
    await page.locator(".bt-result-heading").innerText(),
    /EXNESS.*koneksi.*HISTORY/,
  );
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
    before,
  );
  for (const slots of [1440, 2160]) {
    const count = requests;
    await page
      .getByLabel("Jendela interval tertutup", { exact: true })
      .selectOption(String(slots));
    await page
      .getByRole("button", { name: "Jalankan backtest", exact: true })
      .click();
    await page.getByRole("region", { name: "Laporan backtest" }).waitFor();
    assert.equal(requests - count, slots / 180);
    assert.match(
      await page.locator(".bt-result-heading").innerText(),
      new RegExp(`${slots} candle`),
    );
  }
  fault = { category: "EXNESS_INVALID_TIME_RANGE", code: 3004 };
  await page
    .getByLabel("Jendela interval tertutup", { exact: true })
    .selectOption("1440");
  await page
    .getByRole("button", { name: "Jalankan backtest", exact: true })
    .click();
  const failed = page
    .getByRole("alert")
    .filter({ hasText: "EXNESS_INVALID_TIME_RANGE" });
  await failed.waitFor();
  assert.match(
    await failed.innerText(),
    /HTTP 400.*halaman 5.*720 interval.*720 candle.*provider 3004/,
  );
  assert.equal(
    await page.getByRole("region", { name: "Laporan backtest" }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", {
        name: "Gunakan sampel tersedia (terpotong)",
        exact: true,
      })
      .count(),
    0,
  );
  assert.equal(
    (await page.locator("body").innerText()).includes(
      "private-host-account-price-must-not-display",
    ),
    false,
  );
  fault = { category: "EXNESS_DATA_UNAVAILABLE", code: 4004 };
  await page
    .getByRole("button", { name: "Jalankan backtest", exact: true })
    .click();
  const limited = page
    .getByRole("alert")
    .filter({ hasText: "HISTORY_LIMIT_REACHED" });
  await limited.waitFor();
  assert.match(await limited.innerText(), /SAMPEL TERPOTONG/);
  assert.equal(
    await page.getByRole("region", { name: "Laporan backtest" }).count(),
    0,
  );
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `Truncation warning overflow ${width}`,
    );
  }
  await page.screenshot({
    path: "/workspace/backtest-limit-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: "Gunakan sampel tersedia (terpotong)",
      exact: true,
    })
    .click();
  await page.getByRole("region", { name: "Laporan backtest" }).waitFor();
  assert.match(
    await page.locator(".bt-result-heading").innerText(),
    /720 candle/,
  );
  assert.match(
    await page.getByRole("region", { name: "Laporan backtest" }).innerText(),
    /SAMPEL TERPOTONG.*HISTORY_LIMIT_REACHED/,
  );
  assert.match(
    await page.getByRole("region", { name: "Laporan backtest" }).innerText(),
    /ukuran OOS lebih kecil/,
  );
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
    before,
  );
  await page.getByLabel("EMA cepat", { exact: true }).fill("99");
  await page
    .getByRole("button", { name: "Jalankan backtest", exact: true })
    .click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByRole("region", { name: "Laporan backtest" }).count(),
    0,
  );
  await page.getByLabel("EMA cepat", { exact: true }).fill("9");
  await page.unroute("**/api/account/backtest/history?**");
  await page.route("**/api/account/backtest/history?**", (route) =>
    route.fulfill({ status: 429, json: { error: "RATE_LIMITED" } }),
  );
  await page
    .getByRole("button", { name: "Jalankan backtest", exact: true })
    .click();
  await page.getByRole("alert").filter({ hasText: "RATE_LIMITED" }).waitFor();
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
    before,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real DEMO pagination/report, mocked read-only EXNESS history, separated source labels, IS/OOS equity, parameter/429 handling, unchanged legacy/paper storage, desktop and Android 360/390/412px.",
  );
} finally {
  await browser.close();
}
