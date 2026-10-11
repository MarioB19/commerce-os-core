import { chromium } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { applyLocalEnv } from "./local-env.mjs";
applyLocalEnv();
const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("LOCAL_ONLY");
const extension = await mkdtemp(join(tmpdir(), "commerce-native-zoom-"));
const fixture = JSON.parse(
  await readFile("docs/evidence/sales-review-fixtures.json", "utf8"),
);
let context;
try {
  await writeFile(
    join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Commerce local zoom verification",
      version: "1.0",
      permissions: ["tabs"],
      background: { service_worker: "worker.js" },
    }),
  );
  await writeFile(
    join(extension, "worker.js"),
    "chrome.runtime.onInstalled.addListener(()=>{});",
  );
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: null,
    args: [
      "--window-size=1440,1100",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const response = await context.request.post(
    base + "/api/auth/sign-in/email",
    {
      headers: { Origin: base },
      data: {
        email: process.env.BOOTSTRAP_EMAIL,
        password: process.env.BOOTSTRAP_PASSWORD,
      },
    },
  );
  assert.equal(response.status(), 200);
  const page = await context.newPage();
  await page.goto(base + "/sales/flows/" + fixture.ids.preescolar.flow);
  await page.getByRole("button", { name: "Pasos", exact: true }).click();
  const checks = [];
  for (const zoom of [2, 4]) {
    const measured = await worker.evaluate(
      async ({ url, zoom }) => {
        const tab = (await globalThis.chrome.tabs.query({})).find(
          (t) => t.url === url,
        );
        if (!tab) throw new Error("TAB_MISSING");
        await globalThis.chrome.tabs.setZoomSettings(tab.id, {
          mode: "automatic",
          scope: "per-tab",
        });
        await globalThis.chrome.tabs.setZoom(tab.id, zoom);
        return globalThis.chrome.tabs.getZoom(tab.id);
      },
      { url: page.url(), zoom },
    );
    assert.ok(Math.abs(measured - zoom) < 0.001);
    await page.getByLabel("Buscar paso", { exact: true }).fill("Conocer");
    await page.locator(".search-results button").first().click();
    await page
      .getByRole("textbox", { name: "Texto o descripción", exact: true })
      .scrollIntoViewIfNeeded();
    await page
      .getByRole("textbox", { name: "Texto o descripción", exact: true })
      .focus();
    const metrics = await page.evaluate(() => ({
      inner_width: innerWidth,
      scroll_width: document.documentElement.scrollWidth,
      device_pixel_ratio: devicePixelRatio,
      css_zoom: getComputedStyle(document.documentElement).zoom,
      focused: document.activeElement?.tagName,
    }));
    assert.ok(metrics.scroll_width <= metrics.inner_width);
    assert.equal(metrics.focused, "TEXTAREA");
    checks.push({ native_zoom: measured, ...metrics });
    const cdp = await context.newCDPSession(page);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(
      `docs/evidence/screenshots/sales-native-zoom-${zoom * 100}.png`,
      Buffer.from(shot.data, "base64"),
    );
    await cdp.detach();
  }
  await writeFile(
    "docs/evidence/sales-native-zoom.json",
    JSON.stringify(
      {
        method:
          "Chromium extension globalThis.chrome.tabs.setZoom/getZoom; automatic per-tab native browser zoom; no CSS zoom or page scale emulation",
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(checks));
} finally {
  await context?.close();
  await rm(extension, { recursive: true, force: true });
}
