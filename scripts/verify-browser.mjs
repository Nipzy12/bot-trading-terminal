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
  assert.deepEqual(errors, []);
  console.log(
    "PASS: chart, SL/TP form, persisted positions/history, robot explicit start, emergency, daily risk lock, desktop and Android 360/390/412px; no runtime errors.",
  );
} finally {
  await browser.close();
}
