// Chromium HTTPS/same-origin cookie flow with mocked private APIs; no Exness login.
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const base = "https://nexus.test",
  cookieName = "__Secure-nexus.synthetic_session",
  cookieValue = "synthetic-http-only-value-never-log";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const policy = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
).routes[0].headers["Content-Security-Policy"];
try {
  for (const width of [360, 390, 412])
    for (const scenario of [
      "missing",
      "invalid",
      "SESSION_REVOKED",
      "SESSION_CHANGED",
      "SELECTED_CONNECTION_UNAVAILABLE",
      "ACCOUNT_NOT_SELECTED",
      "READY",
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      });
      if (scenario !== "missing")
        await context.addCookies([
          {
            name: cookieName,
            value:
              scenario === "invalid" ? "invalid-test-signature" : cookieValue,
            url: base,
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
      let preflights = 0,
        sentCookie = false,
        revoked = false;
      await context.addInitScript(() => {
        window.sockets = [];
        window.WebSocket = class {
          constructor(url) {
            this.url = url;
            window.sockets.push(this);
          }
          close() {
            this.onclose?.();
          }
        };
      });
      await context.route("**/*", async (route) => {
        const req = route.request(),
          u = new URL(req.url());
        if (u.origin !== base) return route.abort();
        if (u.pathname.startsWith("/api/")) {
          const authenticated =
            req
              .headers()
              ["cookie"]?.includes(`${cookieName}=${cookieValue}`) === true;
          if (u.pathname === "/api/account/session")
            return route.fulfill({
              status: authenticated && !revoked ? 200 : 401,
              json:
                authenticated && !revoked
                  ? {
                      user: { name: "Synthetic Owner" },
                      csrfToken: "synthetic-csrf",
                    }
                  : { error: "UNAUTHORIZED" },
              headers: { "cache-control": "no-store" },
            });
          if (u.pathname === "/api/live/preflight") {
            preflights++;
            sentCookie = authenticated;
            assert.equal(req.headers().origin, base);
            const code = !authenticated ? "SESSION_MISSING" : scenario;
            if (code === "SESSION_REVOKED") revoked = true;
            return route.fulfill({
              status:
                code === "READY"
                  ? 200
                  : code === "SELECTED_CONNECTION_UNAVAILABLE" ||
                      code === "ACCOUNT_NOT_SELECTED"
                    ? 409
                    : 401,
              json: {
                ready: code === "READY",
                code,
                brokerLiveVerified: false,
              },
              headers: { "cache-control": "no-store" },
            });
          }
          return route.fulfill({
            status: 401,
            json: { error: "UNAUTHORIZED" },
          });
        }
        const path = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
        try {
          return route.fulfill({
            body: await readFile(join(dist, path)),
            contentType:
              extname(path) === ".js"
                ? "text/javascript"
                : extname(path) === ".css"
                  ? "text/css"
                  : "text/html",
            headers: { "content-security-policy": policy },
          });
        } catch {
          return route.abort();
        }
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base + "/?feed=live");
      const expected =
        scenario === "missing" || scenario === "invalid"
          ? "SESSION_MISSING"
          : scenario;
      if (expected === "READY")
        await page.waitForFunction(
          () =>
            window.sockets.filter((s) => s.url.includes("/api/live?"))
              .length === 1,
        );
      else
        await page.getByRole("status").filter({ hasText: expected }).waitFor();
      assert.equal(
        sentCookie,
        scenario !== "missing" && scenario !== "invalid",
      );
      assert.equal(
        await page.evaluate(
          (name) => document.cookie.includes(name),
          cookieName,
        ),
        false,
      );
      assert.equal(
        await page.evaluate(
          (v) => JSON.stringify({ ...localStorage }).includes(v),
          cookieValue,
        ),
        false,
      );
      const sessionStatus = await page.evaluate(
        async () =>
          (
            await fetch("/api/account/session", {
              credentials: "same-origin",
              cache: "no-store",
            })
          ).status,
      );
      assert.equal(
        sessionStatus,
        ["missing", "invalid", "SESSION_REVOKED"].includes(scenario)
          ? 401
          : 200,
      );
      if (expected !== "READY")
        assert.equal(
          await page.evaluate(
            () =>
              window.sockets.filter((s) => s.url.includes("/api/live?")).length,
          ),
          0,
        );
      if (expected === "SELECTED_CONNECTION_UNAVAILABLE")
        await page
          .getByText("Pilihan atau status koneksi berubah.", { exact: false })
          .waitFor();
      assert.notEqual(
        await page.locator(".exchange").textContent(),
        "EXNESS · LIVE",
      );
      assert.equal(
        await page.getByRole("button", { name: "Buy XAUUSD" }).isDisabled(),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.waitForTimeout(100);
      assert.equal(preflights, 1);
      assert.deepEqual(errors, []);
      await context.close();
    }
  console.log(
    "PASS: Android 360/390/412px HTTPS HttpOnly same-origin cookies, private session endpoint, distinct preflight session/selection errors, no retry or fabricated LIVE; mocked auth/provider APIs.",
  );
} finally {
  await browser.close();
}
