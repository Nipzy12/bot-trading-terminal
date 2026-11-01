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
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  console.log("Page loaded");
  await page.locator("canvas").first().waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Buy XAUUSD" }).click();
  await page.getByRole("cell", { name: "Terbuka", exact: true }).waitFor();
  await page.getByRole("button", { name: "Tutup", exact: true }).click();
  await page.getByRole("button", { name: "Riwayat 1" }).click();
  await page.getByRole("cell", { name: "Ditutup", exact: true }).waitFor();
  await page.getByRole("button", { name: "Jalankan robot simulasi" }).click();
  await page.waitForTimeout(10500);
  await page.getByRole("button", { name: "Posisi 1" }).click();
  await page.getByRole("cell", { name: "Terbuka", exact: true }).waitFor();
  await page.getByRole("button", { name: "Hentikan robot" }).click();
  await page.getByRole("button", { name: "4h", exact: true }).click();
  await page.locator("canvas").first().waitFor({ state: "attached" });
  await page.getByRole("textbox", { name: "Cari market" }).fill("EURUSD");
  await page.locator(".watch-row").click();
  await page.getByRole("button", { name: "Buy EURUSD" }).waitFor();
  await page.locator("canvas").first().waitFor({ state: "attached" });
  await page.screenshot({
    path: "/workspace/terminal-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Mobile horizontal overflow",
  );
  await page.screenshot({
    path: "/workspace/terminal-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: chart, paper order, close/history, robot, timeframe, market, mobile layout; no runtime errors.",
  );
} finally {
  await browser.close();
}
