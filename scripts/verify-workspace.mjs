import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const width of [360, 390, 412, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:5173");
    const nav = page.getByRole("navigation", { name: "Navigasi utama" });
    await page
      .locator(".chart-panel canvas")
      .first()
      .waitFor({ state: "visible" });
    assert.equal(await page.locator(".bot-panel").isVisible(), false);
    assert.equal(await page.locator(".google-login").count(), 0);
    if (width < 761)
      await page
        .getByRole("navigation", { name: "Panel Terminal" })
        .getByRole("button", { name: "Order", exact: true })
        .click();
    await page.getByRole("button", { name: "Buy XAUUSD" }).click();
    if (width < 761)
      await page
        .getByRole("navigation", { name: "Panel Terminal" })
        .getByRole("button", { name: "Posisi", exact: true })
        .click();
    await page.locator(".trade-card").waitFor();
    const original = await page.evaluate(() =>
      localStorage.getItem("nexus.paper.v2"),
    );
    await nav.getByRole("link", { name: "Trading Bot", exact: true }).click();
    await page
      .getByRole("button", { name: "Jalankan robot simulasi" })
      .waitFor();
    assert.equal(await page.locator(".chart-panel").isVisible(), false);
    assert.equal(new URL(page.url()).pathname, "/bot");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `bot overflow ${width}`,
    );
    await page.screenshot({
      path: `/workspace/nexus-bot-${width}.png`,
      fullPage: true,
    });
    await nav.getByRole("link", { name: "Markets", exact: true }).click();
    await page.getByLabel("Cari market").fill("XAUUSD");
    assert.equal(await page.locator(".watch-row").count(), 1);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `markets overflow ${width}`,
    );
    await nav.getByRole("link", { name: "Backtest", exact: true }).click();
    await page
      .getByRole("heading", { name: "Strategy Lab", exact: true })
      .waitFor();
    await nav
      .getByRole("link", { name: "Profile & Accounts", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Profile & Accounts", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Login with Google" }).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `overflow ${width}`,
    );
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("nexus.paper.v2")).accounts[0]
            .positions[0].id,
      ),
      JSON.parse(original).accounts[0].positions[0].id,
    );
    await nav.getByRole("link", { name: "Terminal", exact: true }).click();
    if (width < 761)
      await page
        .getByRole("navigation", { name: "Panel Terminal" })
        .getByRole("button", { name: "Chart", exact: true })
        .click();
    await page
      .locator(".chart-panel canvas")
      .first()
      .waitFor({ state: "visible" });
    await page.screenshot({
      path: `/workspace/nexus-redesign-${width}.png`,
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `terminal overflow ${width}`,
    );
    await page.goBack();
    assert.equal(new URL(page.url()).pathname, "/accounts");
    assert.deepEqual(errors, []);
    await page.route("**/api/live/preflight?**", (route) =>
      route.fulfill({ status: 401, json: { code: "SESSION_MISSING" } }),
    );
    await page.goto("http://localhost:5173/?feed=live");
    await page.locator(".connection-details").waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector(".connection-details")
        ?.textContent.includes("SESSION_MISSING"),
    );
    assert.equal(
      await page.locator(".connection-details").getAttribute("open"),
      null,
    );
    await page.getByText("Connection Details", { exact: true }).click();
    assert.equal(
      await page.locator(".connection-details > p").isVisible(),
      true,
    );
    await page.close();
  }
  console.log(
    "PASS: workspace routes, Android 360/390/412, desktop, reduced motion, chart/order/positions, profile, navigation/back, preserved paper position",
  );
} finally {
  await browser.close();
}
