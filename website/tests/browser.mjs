import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(root, "..", ".test-artifacts", "website");
await fs.mkdir(artifacts, { recursive: true });
const port = Number(process.env.OTDS_WEBSITE_TEST_PORT || 4175);
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
server.stdout.on("data", (chunk) => {
  output += chunk;
});
server.stderr.on("data", (chunk) => {
  output += chunk;
});
const base = `http://127.0.0.1:${port}/OneTimeDownloadService/`;
const report = {
  date: new Date().toISOString(),
  checks: [],
  errors: [],
  screenshots: [],
  requests: [],
};
const check = (name) => {
  report.checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
async function capture(page, name) {
  await page.screenshot({ path: path.join(artifacts, name + ".png") });
  report.screenshots.push(name + ".png");
}
function record(page) {
  page.on("pageerror", (error) =>
    report.errors.push(`${page.url()}: ${error.stack}`),
  );
  page.on("response", (response) => {
    if (response.url().startsWith(base) && response.status() >= 400)
      report.errors.push(`${response.status()}: ${response.url()}`);
  });
  page.on("request", (request) => report.requests.push(request.url()));
}
async function jump(page, id) {
  await page.evaluate(
    (id) =>
      window.scrollTo({
        top: document.getElementById(id).offsetTop,
        behavior: "instant",
      }),
    id,
  );
  await page.waitForTimeout(450);
}
async function waitForGuidePosition(page) {
  await page.waitForFunction(() => {
    const top = document.getElementById("guide").getBoundingClientRect().top;
    return top >= 0 && top < 125;
  });
  await page.waitForTimeout(250);
}
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(output);
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* Wait for preview startup. */
    }
    await sleep(100);
  }
  browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  record(page);
  await page.goto(base);
  await page.waitForFunction(
    () => document.querySelector(".scene").dataset.mode === "webgl",
  );
  assert.equal(await page.locator("html").getAttribute("lang"), "ko");
  assert.equal(await page.locator(".guide").getAttribute("open"), null);
  await capture(page, "hero-desktop");
  check("프로젝트 경로에서 에셋·실제 WebGL 모델 로딩 및 한국어 기본 화면");

  let previous = -1;
  for (const [i, id] of [
    "hero",
    "single",
    "retry",
    "integrity",
    "control",
    "deploy",
  ].entries()) {
    await jump(page, id);
    const stage = Number(
      await page.locator("#core-canvas").getAttribute("data-stage"),
    );
    assert.ok(Math.abs(stage - i) < 0.15, `${id}: stage=${stage}`);
    assert.ok(stage >= previous);
    previous = stage;
    assert.equal(
      await page.locator("#chapter-number").innerText(),
      String(i + 1).padStart(2, "0"),
    );
    if (i > 0)
      assert.ok(
        Number(
          await page
            .locator(`#${id} .section-content`)
            .evaluate((element) => getComputedStyle(element).opacity),
        ) > 0.95,
      );
    if ([1, 2, 3, 4, 5].includes(i)) await capture(page, id + "-desktop");
  }
  await jump(page, "hero");
  assert.ok(
    Number(await page.locator("#core-canvas").getAttribute("data-stage")) <
      0.05,
  );
  await jump(page, "control");
  await jump(page, "single");
  assert.ok(
    Math.abs(
      Number(await page.locator("#core-canvas").getAttribute("data-stage")) - 1,
    ) < 0.15,
  );
  check("6개 스크롤 구간의 모델·문구 일치, 역방향 및 빠른 구간 이동");
  await page.setViewportSize({ width: 1100, height: 760 });
  await jump(page, "integrity");
  assert.ok(
    Math.abs(
      Number(await page.locator("#core-canvas").getAttribute("data-stage")) - 3,
    ) < 0.15,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  check("화면 크기 변경 후 스크롤 동기화");

  await page.mouse.move(1350, 750);
  await page.waitForTimeout(300);
  const tiltedFrames = Number(
    await page.locator("#core-canvas").getAttribute("data-frames"),
  );
  await page.mouse.move(50, 150);
  await page.waitForTimeout(300);
  assert.ok(
    Number(await page.locator("#core-canvas").getAttribute("data-frames")) >
      tiltedFrames,
  );
  await page.evaluate(() => {
    window.otdsTestHidden = true;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => window.otdsTestHidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenFrames = await page
    .locator("#core-canvas")
    .getAttribute("data-frames");
  await jump(page, "retry");
  assert.equal(
    await page.locator("#core-canvas").getAttribute("data-frames"),
    hiddenFrames,
  );
  await page.evaluate(() => {
    window.otdsTestHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(
    () =>
      Math.abs(
        Number(document.getElementById("core-canvas").dataset.stage) - 2,
      ) < 0.15,
  );
  check("포인터 기울기 갱신 및 숨김 탭 신호에서 렌더링 정지·복귀");

  await jump(page, "start");
  await page.locator(".primary.guide-link").click();
  await page.waitForFunction(
    () => location.hash === "#guide" && document.getElementById("guide").open,
  );
  assert.equal(await page.locator(".guide-card").count(), 6);
  await waitForGuidePosition(page);
  await capture(page, "guide-desktop");
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById("guide").open);
  await page.goForward();
  await page.waitForFunction(() => document.getElementById("guide").open);
  await page.reload();
  await page.waitForFunction(() => document.getElementById("guide").open);
  check("Use Now 가이드 펼침·이동, 뒤로/앞으로, #guide 새로고침");
  await page.goto(base + "#control");
  await page.waitForFunction(
    () =>
      Math.abs(
        Number(document.getElementById("core-canvas").dataset.stage) - 4,
      ) < 0.2,
  );
  check("특징 구간 주소 직접 접속 시 스크롤과 모델 초기화");
  await page.goto(base + "#guide");

  await page.locator('[data-language="en"]').click();
  assert.match(page.url(), /lang=en#guide$/);
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  assert.equal(
    await page.locator(".guide-heading").innerText(),
    "Installation & setup guide",
  );
  assert.equal(await page.locator(".primary").innerText(), "Use Now\n↗");
  assert.equal(
    await page
      .locator('[data-command="start.cmd"]')
      .getAttribute("data-command"),
    "start.cmd",
  );
  await page.locator('[data-command="python --version"]').click();
  await page.waitForFunction(
    () =>
      document.getElementById("copy-status").textContent === "Command copied.",
  );
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "python --version",
  );
  await page.goto(base);
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.goto(base + "?lang=ko#guide");
  assert.equal(await page.locator("html").getAttribute("lang"), "ko");
  await page.goto(base + "?lang=en#guide");
  await page.waitForFunction(() => document.getElementById("guide").open);
  assert.equal(
    await page.locator(".guide-heading").innerText(),
    "Installation & setup guide",
  );
  check("한영 전환·저장·쿼리 우선순위·영어 직접 공유·실제 클립보드 복사");
  const star = page.locator(".secondary");
  assert.equal(
    await star.getAttribute("href"),
    "https://github.com/movenb3at/OneTimeDownloadService",
  );
  assert.equal(await star.getAttribute("target"), "_blank");
  assert.match(await star.getAttribute("rel"), /noopener/);
  assert.equal(
    await page.locator('[data-i18n="zip"]').getAttribute("href"),
    "https://github.com/movenb3at/OneTimeDownloadService/archive/refs/heads/main.zip",
  );
  await page.locator("#guide > summary").click();
  await page.waitForFunction(
    () => !document.getElementById("guide").open && location.hash !== "#guide",
  );
  check("저장소·ZIP 주소 및 수동 가이드 접기와 주소 동기화");
  await page.goto(base + "?lang=ko");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement.className),
    "skip-link",
  );
  await page.keyboard.press("Enter");
  assert.equal(new URL(page.url()).hash, "#main");
  check("키보드 본문 바로가기");

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const phone = await mobile.newPage();
  record(phone);
  await phone.goto(base);
  await phone.waitForFunction(
    () => document.querySelector(".scene").dataset.mode === "webgl",
  );
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.ok(
    await phone
      .locator("#core-canvas")
      .evaluate((canvas) => canvas.width <= innerWidth * 1.21),
  );
  await capture(phone, "hero-mobile");
  await jump(phone, "retry");
  await capture(phone, "retry-mobile");
  await phone.locator("nav .guide-link").click();
  await phone.waitForFunction(() => document.getElementById("guide").open);
  await waitForGuidePosition(phone);
  await capture(phone, "guide-mobile");
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await phone.locator('[data-language="en"]').click();
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  check("390×844 모바일 모델·가이드·언어 전환, 가로 넘침 없음, DPR 제한");

  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const quiet = await reduced.newPage();
  record(quiet);
  await quiet.goto(base + "?lang=en#guide");
  await quiet.waitForFunction(() => document.getElementById("guide").open);
  assert.equal(await quiet.locator(".core-fallback").isVisible(), true);
  assert.equal(
    await quiet.locator("#core-canvas").getAttribute("data-stage"),
    null,
  );
  await quiet.goto(base);
  await capture(quiet, "reduced-motion");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    () => document.querySelector(".scene").dataset.mode === "static",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(
    () => document.querySelector(".scene").dataset.mode === "webgl",
  );
  check("모션 감소 초기 접근과 실행 중 설정 변경, 정적 그림 대체");

  const noGL = await browser.newContext();
  await noGL.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.startsWith("webgl")
        ? null
        : original.call(this, type, ...args);
    };
  });
  const fallback = await noGL.newPage();
  record(fallback);
  await fallback.goto(base);
  await fallback.waitForFunction(
    () => document.querySelector(".scene").dataset.mode === "static",
  );
  assert.ok(await fallback.locator(".core-fallback").isVisible());
  await fallback.locator("nav .guide-link").click();
  await fallback.waitForFunction(() => document.getElementById("guide").open);
  check("WebGL 실패 시 정적 코어·본문·가이드 동작");
  const noJS = await browser.newContext({ javaScriptEnabled: false });
  const plain = await noJS.newPage();
  record(plain);
  await plain.goto(base);
  await plain.locator("#guide > summary").click();
  assert.ok(await plain.locator(".guide-card").first().isVisible());
  check("JavaScript 비활성화 시 한국어 본문·네이티브 설치 가이드");
  assert.deepEqual(report.errors, []);
  assert.ok(
    report.requests.every((url) => url.startsWith(base)),
    "All page assets must be self-hosted.",
  );
  check("외부 CDN 요청·실패 에셋·JavaScript 예외 없음");
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => {
    if (server.exitCode !== null) resolve();
    else server.once("exit", resolve);
  });
  report.preview_stopped = true;
  report.requests = [...new Set(report.requests)];
  await fs.writeFile(
    path.join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
