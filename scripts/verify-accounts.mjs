import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const base = process.env.BASE_URL || "http://localhost:5173";
  const unconfigured = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await unconfigured.goto(base + "/accounts", {
    waitUntil: "domcontentloaded",
  });
  await unconfigured
    .getByText("Account Management belum diaktifkan", { exact: true })
    .waitFor();
  assert.equal(await unconfigured.locator("input[name=apiKey]").count(), 0);
  await unconfigured.close();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let loggedIn = false,
    accounts = [];
  let submitted = false;
  let testCount = 0;
  const id = "11111111-1111-4111-8111-111111111111";
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/account/config")
      return route.fulfill({ json: { enabled: true } });
    if (path === "/api/auth/sign-in/email") {
      loggedIn = true;
      return route.fulfill({ json: { success: true } });
    }
    if (path === "/api/auth/sign-out") {
      loggedIn = false;
      return route.fulfill({ json: { success: true } });
    }
    if (!loggedIn)
      return route.fulfill({ status: 401, json: { error: "UNAUTHORIZED" } });
    if (path === "/api/account/session")
      return route.fulfill({
        json: { user: { name: "Mobile Tester" }, csrfToken: "synthetic-csrf" },
      });
    if (method !== "GET")
      assert.equal(request.headers()["x-csrf-token"], "synthetic-csrf");
    if (path === "/api/account/connections" && method === "POST") {
      const input = request.postDataJSON();
      assert.equal(input.apiKey, "synthetic-only-api-key");
      assert.equal(input.privateKey, "synthetic-only-signing-key");
      submitted = true;
      accounts = [
        {
          id,
          label: input.label,
          status: "saved",
          selected: false,
          tested_at: null,
        },
      ];
      return route.fulfill({
        status: 201,
        json: { id, label: input.label, status: "saved" },
      });
    }
    if (path.endsWith("/test")) {
      testCount++;
      const failed = testCount === 1;
      accounts[0].status = failed ? "error" : "verified";
      accounts[0].tested_at = new Date().toISOString();
      return route.fulfill({
        status: failed ? 502 : 200,
        json: {
          status: failed ? "error" : "verified",
          success: !failed,
          live: false,
          ...(failed
            ? {
                stage: "candles",
                error: "EXNESS_INVALID_RESPONSE",
                reason: "EMPTY_CANDLES",
                candleCount: 0,
              }
            : {}),
          stages: ["discovery", "account_details", "limits", "candles"].map(
            (stage) => ({
              stage,
              status: failed && stage === "candles" ? "failed" : "passed",
            }),
          ),
        },
      });
    }
    if (path === "/api/account/selection") {
      accounts[0].selected = true;
      return route.fulfill({ json: { selected: true } });
    }
    if (method === "DELETE") {
      accounts = [];
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({ json: { accounts } });
  });
  await page.goto(base + "/accounts", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email", { exact: true }).fill("mobile@example.test");
  await page
    .getByLabel("Password aplikasi", { exact: true })
    .fill("synthetic-mobile-password");
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect Exness", exact: true })
    .click();
  await page
    .getByLabel("Nama koneksi", { exact: true })
    .fill("Private workspace");
  await page
    .getByLabel("API Key", { exact: true })
    .fill("synthetic-only-api-key");
  await page
    .getByLabel("Private Signing Key", { exact: true })
    .fill("synthetic-only-signing-key");
  await page.getByLabel("Account ID", { exact: true }).fill("123456");
  await page
    .getByLabel("Gateway URL", { exact: true })
    .fill("https://gateway.exness.com");
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Simpan terenkripsi", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Test Connection", exact: true })
    .waitFor();
  assert.equal(submitted, true);
  assert.equal(await page.locator("textarea[name=privateKey]").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Pilih akun", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Test Connection", exact: true })
    .click();
  const diagnostic = page.getByRole("region", {
    name: "Hasil tahap Test Connection",
  });
  await diagnostic
    .getByText("EXNESS_INVALID_RESPONSE · XAUUSD · H1 candle history", {
      exact: true,
    })
    .waitFor();
  await diagnostic.getByText("Jumlah candle: 0", { exact: true }).waitFor();
  assert.match(await diagnostic.locator("li").nth(1).innerText(), /Lulus/);
  assert.match(await diagnostic.locator("li").nth(3).innerText(), /Gagal/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/workspace/exness-test-failure-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Test Connection", exact: true })
    .click();
  await page.getByText("EXNESS · history teruji", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Pilih akun", exact: true }).click();
  await page
    .getByRole("link", { name: "Buka chart EXNESS history →", exact: true })
    .waitFor();
  await page.screenshot({
    path: "/workspace/accounts-desktop.png",
    fullPage: true,
  });
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `Account overflow ${width}`,
    );
  }
  await page.screenshot({
    path: "/workspace/accounts-mobile.png",
    fullPage: true,
  });
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  assert.equal(storage.includes("synthetic-only-api-key"), false);
  assert.equal(storage.includes("synthetic-only-signing-key"), false);
  page.on("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Disconnect & hapus", exact: true })
    .click();
  await page
    .getByText("Belum ada koneksi Exness. DEMO publik tetap menjadi default.", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Keluar", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: disabled service gate, mocked account login/connect/test/select/delete/logout UI, CSRF header, no credential browser storage, desktop and Android 360/390/412px. Real auth and database isolation are covered by backend tests.",
  );
} finally {
  await browser.close();
}
