import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.BASE_URL || "http://localhost:5173", {
    waitUntil: "domcontentloaded",
  });
  await page.locator("canvas").first().waitFor({ state: "attached" });
  const buy = page.getByRole("button", { name: "Buy XAUUSD" });
  await buy.waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".submit-order").disabled,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  await page.getByLabel("Stop Loss (harga)").fill("2700");
  await page.getByLabel("Take Profit (harga)").fill("2800");
  await buy.click();
  await page.locator(".trade-card").waitFor();
  assert.match(await page.locator(".trade-card").innerText(), /SL 2,700/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".trade-card").waitFor();
  assert.equal(await page.locator(".trade-card").count(), 1);
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Jalankan robot simulasi", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".trade-card").length === 2,
    {},
    { timeout: 15000 },
  );
  await page.screenshot({
    path: "/workspace/terminal-desktop.png",
    fullPage: true,
  });
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `Overflow at ${width}`,
    );
    assert.equal(
      await page
        .locator(".trade-card")
        .first()
        .evaluate(
          (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length,
        ),
      2,
    );
  }
  await page.screenshot({
    path: "/workspace/terminal-mobile.png",
    fullPage: true,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".trade-card").first().waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  await page.waitForFunction(
    () => !document.querySelector(".submit-order").disabled,
  );
  await page
    .getByRole("button", { name: "Emergency stop · tutup semua", exact: true })
    .click();
  await page.getByRole("button", { name: "Riwayat 2", exact: true }).click();
  assert.equal(await page.locator(".trade-card").count(), 2);
  assert.match(
    await page.locator(".trade-card").first().innerText(),
    /Emergency/,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Riwayat 2", exact: true }).click();
  assert.equal(await page.locator(".trade-card").count(), 2);
  assert.equal(
    await page
      .getByRole("button", { name: "Jalankan robot simulasi", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", {
      name: "Buka kunci manual (robot tetap berhenti)",
      exact: true,
    })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  // Persist a real daily-loss record to verify startup risk blocking in the UI.
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem("nexus.paper.v1"));
    a.history[0].pnl = -150;
    a.history[0].closedAt = Date.now();
    localStorage.setItem("nexus.paper.v1", JSON.stringify(a));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Robot terkunci", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Jalankan robot simulasi", exact: true })
      .isDisabled(),
    true,
  );
  const providerPage = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  providerPage.setDefaultTimeout(15000);
  providerPage.on("pageerror", (e) => errors.push(e.message));
  let mode = "rate",
    requests = 0;
  await providerPage.route("**/api/market?**", async (route) => {
    requests++;
    if (mode === "rate") {
      await route.fulfill({
        status: 429,
        json: { error: "EXNESS_RATE_LIMIT", retryAfter: 1 },
      });
      return;
    }
    const start = Math.floor(Date.now() / 1000) - 180 * 3600;
    await route.fulfill({
      json: {
        source: "exness",
        label: "EXNESS",
        kind: "candle-history",
        live: false,
        candles: Array.from({ length: 180 }, (_, i) => ({
          time: start + i * 3600,
          open: 2740,
          high: 2742,
          low: 2738,
          close: 2740,
        })),
      },
    });
  });
  await providerPage.goto(process.env.BASE_URL || "http://localhost:5173", {
    waitUntil: "domcontentloaded",
  });
  await providerPage.getByRole("alert").waitFor();
  await providerPage.waitForTimeout(1000);
  const initialRequests = requests;
  await providerPage.waitForTimeout(5500);
  assert.equal(requests, initialRequests, "429 must stop automatic polling");
  assert.equal(
    await providerPage
      .getByRole("button", { name: "Jalankan robot simulasi", exact: true })
      .isDisabled(),
    true,
  );
  mode = "exness";
  await providerPage
    .getByRole("button", { name: "Coba lagi", exact: true })
    .click();
  await providerPage.waitForFunction(
    () =>
      document.querySelector(".exchange")?.textContent === "EXNESS · HISTORY",
  );
  assert.match(
    await providerPage.locator(".chart-footer").innerText(),
    /bukan live ticks/,
  );
  assert.equal(
    await providerPage
      .getByRole("button", { name: "Hentikan robot", exact: true })
      .count(),
    0,
  );
  await providerPage.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Exness history label and manual 429 recovery, chart, SL/TP form, persisted positions/history, robot explicit start, emergency, daily risk lock, desktop and Android 360/390/412px; no runtime errors.",
  );
} finally {
  await browser.close();
}
