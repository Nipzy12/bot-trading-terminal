import { workspacePage } from "./workspace-navigation.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser
    .newPage({
      viewport: { width: 1440, height: 1000 },
    })
    .then(workspacePage);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let calls = 0,
    fail = false,
    stale = false;
  await page.route("**/api/account/monitor", (r) => {
    calls++;
    return r.fulfill(
      fail
        ? {
            status: 429,
            headers: { "Retry-After": "2" },
            json: { status: "UNAVAILABLE" },
          }
        : {
            json: {
              balance: "15234.99",
              equity: "15100.01",
              used_margin: "123.45",
              currency: "USD",
              asOf: new Date(Date.now() - (stale ? 31000 : 0)).toISOString(),
              status: "SNAPSHOT",
            },
          },
    );
  });
  await page.goto("http://localhost:5173/");
  await page.locator("canvas").first().waitFor({ state: "attached" });
  const card = page.getByLabel("EXNESS DEMO ACCOUNT MONITOR");
  assert.equal(calls, 0);
  assert.match(await card.innerText(), /UNAVAILABLE/);
  assert.equal((await card.innerText()).includes("10,000"), false);
  const before = await page.evaluate(() =>
    localStorage.getItem("nexus.paper.v2"),
  );
  await card
    .getByRole("button", { name: "Refresh saldo broker", exact: true })
    .click();
  await card.getByText("15,234.99", { exact: true }).waitFor();
  assert.match(
    await page.locator(".account").innerText(),
    /NEXUS PAPER · Saldo Virtual/,
  );
  assert.match(await page.locator(".account").innerText(), /\$10,000.00/);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("nexus.paper.v2")),
    before,
  );
  assert.equal(
    await page.evaluate(() => ({ ...localStorage })["balance"]),
    undefined,
  );
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `Monitor overflow ${width}`,
    );
  }
  await page.screenshot({
    path: "/workspace/broker-monitor-mobile.png",
    fullPage: true,
  });
  const current = calls;
  await page.waitForTimeout(1500);
  assert.equal(calls, current);
  fail = true;
  await card
    .getByRole("button", { name: "Refresh saldo broker", exact: true })
    .click();
  await card
    .getByText("Currency belum tersedia · UNAVAILABLE", { exact: true })
    .waitFor();
  assert.equal((await card.innerText()).includes("15,234.99"), false);
  assert.equal((await card.innerText()).includes("10,000"), false);
  assert.equal(await card.getByRole("button").isDisabled(), true);
  await page.waitForTimeout(2200);
  fail = false;
  stale = true;
  await card
    .getByRole("button", { name: "Refresh saldo broker", exact: true })
    .click();
  await card.getByText("USD · STALE", { exact: true }).waitFor();
  const n = calls;
  await page.evaluate(() => {
    const channel = new BroadcastChannel("nexus-account-change");
    channel.postMessage("changed");
    channel.close();
  });
  await card
    .getByText("Currency belum tersedia · UNAVAILABLE", { exact: true })
    .waitFor();
  assert.equal(calls, n);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("nexus.paper.v2")),
    before,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: distinct broker snapshot vs paper balance, no automatic fetch/poll, no paper/storage changes, unavailable on 429 with cooldown, desktop and Android 360/390/412px. Mock broker balance only.",
  );
} finally {
  await browser.close();
}
