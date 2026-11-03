import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const base = process.env.BASE_URL || "http://localhost:5173";
try {
  for (const width of [360, 390, 412, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(base + "/accounts");
    await page
      .getByText("Google Login belum dikonfigurasi", { exact: false })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Login with Google" })
        .isDisabled(),
      true,
    );
    await page.locator("canvas").first().waitFor({ state: "attached" });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  // Mock only the SDK adapter at the dev-server boundary, never a production auth bypass.
  await page.route("**/src/firebase-login.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
 let listener; let signedIn=false;
 export const authMessage=()=>"Login dibatalkan. DEMO tetap tersedia.";
 export function createGoogleLogin(){return {
 observe(next){listener=next;setTimeout(()=>next(signedIn?{displayName:'Test User',email:'test@example.test'}:null),100);return ()=>{listener=null}},
 async login(){await new Promise(r=>setTimeout(r,150));signedIn=true;listener?.({displayName:'Test User',email:'test@example.test'})},
 async logout(){signedIn=false;listener?.(null)}
 }}
 `,
    }),
  );
  await page.goto(base + "/accounts");
  await page.getByRole("button", { name: "Login with Google" }).click();
  await page.getByText("Test User", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Logout Google" }).click();
  await page.getByText("Belum login · DEMO publik", { exact: true }).waitFor();
  console.log(
    "Google auth: missing-config DEMO desktop/360/390/412 and mocked login/profile/logout passed",
  );
} finally {
  await browser.close();
}
