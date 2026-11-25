// Bounded production read-only probe: fresh unauthenticated contexts; no credentials or data.
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  pathToFileURL(
    process.env.APERO_PLAYWRIGHT_MODULE ??
      "/tmp/apero-onboarding-tooling/browser/node_modules/playwright/index.mjs",
  )
);
const out = resolve("docs/release/2026-11-24/evidence");
await mkdir(out, { recursive: true });
const result = {
  checked_at: new Date().toISOString(),
  scope:
    "Fresh unauthenticated browser only; all non-GET and Supabase/provider requests blocked; no credentials entered",
  tests: [],
  errors: [],
  blocked_requests: [],
};
const browser = await chromium.launch({ headless: true });
result.browser_version = browser.version();
try {
  for (const width of [1440, 768, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.route("**/*", (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (
        req.method() === "GET" &&
        ["aperodashboard.lovable.app", "fonts.googleapis.com", "fonts.gstatic.com"].includes(
          url.hostname,
        )
      )
        return route.continue();
      result.blocked_requests.push({
        method: req.method(),
        host: url.hostname,
        path: url.pathname,
      });
      return route.abort();
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => result.errors.push({ width, type: e.name, message: e.message }));
    page.setDefaultTimeout(20000);
    for (const path of [
      "/login",
      "/home",
      "/calendar",
      "/clients",
      "/conversations",
      "/requests",
      "/analytics",
      "/account",
      "/account/team",
      "/account/settings",
    ]) {
      try {
        await page.goto("https://aperodashboard.lovable.app" + path, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForURL("**/login");
        await page.locator("input[type=password]").waitFor();
        const geometry = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          width: innerWidth,
        }));
        result.tests.push({
          id: "PROD-UNAUTH:" + width + ":" + path,
          path,
          width,
          status: geometry.scrollWidth <= width + 1 ? "PASS" : "FAIL",
          landed: "/login",
          ...geometry,
        });
        if (path === "/login")
          await page.screenshot({
            path: resolve(out, "browser-production-login-" + width + ".png"),
            fullPage: true,
          });
      } catch (e) {
        result.tests.push({
          id: "PROD-UNAUTH:" + width + ":" + path,
          path,
          width,
          status: "FAIL",
          error: e.name,
          message: e.message,
        });
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(out, "browser-production-public.json"), JSON.stringify(result, null, 2));
}
console.log(
  JSON.stringify({
    pass: result.tests.filter((x) => x.status === "PASS").length,
    fail: result.tests.filter((x) => x.status === "FAIL").length,
    errors: result.errors,
    blocked: result.blocked_requests,
  }),
);
if (result.tests.some((x) => x.status === "FAIL")) process.exitCode = 1;
