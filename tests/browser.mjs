import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_PATH || "playwright";
const {chromium, devices} = require(playwrightPath);
const artifacts = path.join(root, ".test-artifacts", "browser");
await fs.mkdir(artifacts, {recursive: true});
const dataDir = await fs.mkdtemp(path.join(root, ".test-artifacts", "live-"));
const password = crypto.randomBytes(24).toString("hex");
const tunnelMode = process.argv.includes("--tunnel");
const port = Number(process.env.OTD_TEST_PORT || 8091);
const python = path.join(root, ".venv", "Scripts", "python.exe");
const child = spawn(python, [path.join(root, "runtime.py"), "--data-dir", dataDir, "--port", String(port), ...(tunnelMode ? [] : ["--local"])], {
  cwd: root, env: {...process.env, OTD_SETUP_PASSWORD: password, PYTHONIOENCODING: "utf-8"},
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
});
let runtimeOutput = "";
child.stdout.on("data", chunk => { runtimeOutput += chunk.toString(); });
child.stderr.on("data", chunk => { runtimeOutput += chunk.toString(); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (child.exitCode !== null) throw new Error("검증 서버 종료: " + runtimeOutput);
    await sleep(150);
  }
  throw new Error("검증 대기 시간 초과: " + runtimeOutput);
}
const report = {started_at: new Date().toISOString(), tunnel: tunnelMode, checks: [], console_errors: [], screenshots: []};
let browser, base;
function check(name) { report.checks.push(name); process.stdout.write("PASS " + name + "\n"); }
async function screenshot(page, name) {
  await page.screenshot({path: path.join(artifacts, name + ".png"), fullPage: true});
  report.screenshots.push(name + ".png");
}
async function login(page) {
  await page.goto(base + "/admin.html");
  await page.locator("#password").fill(password);
  await page.locator("#login-button").click();
  await page.locator("#dashboard").waitFor({state: "visible"});
  await page.waitForFunction(() => document.getElementById("updated").textContent.startsWith("갱신 "));
}
async function upload(page, name, buffer) {
  const previous = await page.locator("#latest-link").inputValue();
  await page.locator("#upload-file").setInputFiles({name, mimeType: "application/octet-stream", buffer});
  await page.locator("#upload-button").click();
  await page.waitForFunction(previous => document.getElementById("latest-link").value !== previous && document.getElementById("latest-link").value.includes("#token="), previous);
  await page.waitForFunction(name => document.getElementById("file-rows").textContent.includes(name), name);
  return await page.locator("#latest-link").inputValue();
}
async function stats(page) {
  return await page.evaluate(async () => (await fetch("/api/admin/dashboard")).json());
}
try {
  await waitUntil(async () => {
    try { return (await fetch("http://127.0.0.1:" + port + "/api/health")).ok; }
    catch (_) { return false; }
  });
  if (tunnelMode) {
    await waitUntil(() => runtimeOutput.includes("공개 관리자:"), 90000);
    const match = runtimeOutput.match(/공개 관리자: (https:\/\/[a-z0-9-]+\.trycloudflare\.com)\/admin\.html/);
    assert.ok(match, "공개 터널 주소가 있어야 합니다.");
    base = match[1];
  } else base = "http://127.0.0.1:" + port;
  report.base_url = base;
  browser = await chromium.launch({channel: "msedge", headless: true});
  const adminContext = await browser.newContext({viewport: {width: 1365, height: 900}});
  const admin = await adminContext.newPage();
  const recordErrors = page => page.on("pageerror", error => report.console_errors.push(error.message));
  recordErrors(admin);
  // 새 임시 도메인의 DNS와 연결이 준비되는 시간을 허용합니다.
  await waitUntil(async () => { try { const response = await admin.goto(base + "/api/health", {timeout: 15000}); return response.ok(); } catch (_) { return false; } }, 60000);
  await login(admin);
  check("관리자 로그인 및 세션");
  const payload = Buffer.from("브라우저에서 수신한 파일을 SHA-256으로 확인합니다.\n", "utf8");
  const shareUrl = await upload(admin, "검증 파일.txt", payload);
  assert.ok(shareUrl.startsWith(base + "/index.html#token="));
  assert.equal((await stats(admin)).summary.completed, 0);
  check("관리자 파일 업로드 및 현재 주소로 링크 발급");
  const userContext = await browser.newContext({viewport: {width: 1280, height: 900}, acceptDownloads: true});
  const user = await userContext.newPage(); recordErrors(user);
  await user.goto(shareUrl);
  await user.locator("#download-link:not(.disabled)").waitFor();
  await screenshot(user, "share-desktop");
  await user.reload();
  await user.locator("#download-link:not(.disabled)").waitFor();
  assert.equal((await stats(admin)).summary.attempts, 0);
  check("공유 화면 조회와 새로고침은 권한 미소모");
  const mobileContext = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, userAgent: devices["Pixel 7"].userAgent});
  const mobile = await mobileContext.newPage(); recordErrors(mobile);
  await mobile.goto(shareUrl);
  await mobile.locator("#download-link:not(.disabled)").waitFor();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(mobile, "share-mobile");
  await user.locator("#download-link").click();
  await user.locator("#start-download:not([disabled])").waitFor();
  await screenshot(user, "download-desktop");
  const [download] = await Promise.all([user.waitForEvent("download"), user.locator("#start-download").click()]);
  const downloadedPath = path.join(artifacts, "received-file.txt");
  await download.saveAs(downloadedPath);
  assert.deepEqual(await fs.readFile(downloadedPath), payload);
  await user.locator("#save-file").waitFor({state: "visible"});
  assert.equal((await stats(admin)).summary.completed, 1);
  check("다운로드 화면 이동, 파일 수신, 해시 검증 및 실제 저장");
  await user.reload();
  await user.waitForFunction(() => document.getElementById("state-badge").textContent === "수신 완료");
  assert.ok(await user.locator("#start-download").isDisabled());
  check("완료 링크의 추가 전송 차단");
  // 느린 연결에서 수신을 중단하고 동일한 브라우저만 재시도하는지 확인합니다.
  const retryPayload = Buffer.alloc(4 * 1024 * 1024, 97);
  const retryUrl = await upload(admin, "재시도 검증.bin", retryPayload);
  await user.goto(retryUrl.replace("/index.html", "/download.html"));
  await user.locator("#start-download:not([disabled])").waitFor();
  const cdp = await userContext.newCDPSession(user);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {offline: false, latency: 15, downloadThroughput: 128 * 1024, uploadThroughput: 10 * 1024 * 1024});
  await user.locator("#start-download").click();
  await user.waitForFunction(() => document.getElementById("progress").value > 0);
  await user.locator("#cancel-download").click();
  await user.waitForFunction(() => document.getElementById("message").textContent.includes("중단"));
  const before = await stats(admin);
  const retryLink = before.links.find(link => link.name === "재시도 검증.bin");
  assert.equal(retryLink.state, "reserved");
  assert.equal(retryLink.expires_at - retryLink.reserved_at, 600);
  await mobile.goto(retryUrl.replace("/index.html", "/download.html"));
  await mobile.waitForFunction(() => document.getElementById("message").textContent.includes("다른 브라우저"));
  assert.ok(await mobile.locator("#start-download").isDisabled());
  await screenshot(mobile, "download-mobile");
  check("전송 중단, 10분 예약, 다른 브라우저의 전송 차단");
  await cdp.send("Network.emulateNetworkConditions", {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
  await waitUntil(async () => !(await stats(admin)).attempts.some(attempt => attempt.status === "streaming"));
  // 서버가 완료 처리한 뒤 응답만 유실되는 상황을 재현합니다.
  let lostResponse = false;
  await user.route("**/api/public/downloads/*/complete", async route => {
    if (!lostResponse) { lostResponse = true; await route.fetch(); await route.abort("failed"); }
    else await route.continue();
  });
  const [retriedDownload] = await Promise.all([user.waitForEvent("download"), user.locator("#start-download").click()]);
  await retriedDownload.saveAs(path.join(artifacts, "retried-file.bin"));
  assert.deepEqual(await fs.readFile(path.join(artifacts, "retried-file.bin")), retryPayload);
  await user.locator("#save-file").waitFor({state: "visible"});
  const after = await stats(admin);
  assert.equal(after.summary.completed, 2);
  assert.equal(after.summary.retries, 1);
  assert.equal(after.links.find(link => link.id === retryLink.id).expires_at, retryLink.expires_at);
  check("동일 브라우저 재시도, 만료 시각 유지, 완료 응답 유실 시 중복 집계 방지");
  await user.unroute("**/api/public/downloads/*/complete");
  await admin.reload();
  await admin.locator("#dashboard").waitFor({state: "visible"});
  await admin.waitForFunction(() => document.getElementById("metric-completed").textContent === "2");
  assert.ok((await stats(admin)).devices.every(device => !Object.hasOwn(device, "ip")));
  assert.ok((await stats(admin)).devices.some(device => device.device_type === "모바일" && device.os === "Android" && device.browser === "Chrome"));
  await screenshot(admin, "admin-desktop");
  await login(mobile);
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(mobile, "admin-mobile");
  check("전체·파일별·기기별 통계 및 모바일 화면");
  await admin.locator("#file-rows tr").filter({hasText: "검증 파일.txt"}).getByRole("button", {name: "새 링크 발급"}).click();
  await admin.waitForFunction(previous => document.getElementById("latest-link").value !== previous && document.getElementById("latest-link").value.includes("#token="), shareUrl);
  const directUrl = (await admin.locator("#latest-link").inputValue()).replace("/index.html", "/download.html");
  await mobile.goto(directUrl);
  await mobile.locator("#start-download:not([disabled])").waitFor();
  const [directDownload] = await Promise.all([mobile.waitForEvent("download"), mobile.locator("#start-download").click()]);
  await directDownload.saveAs(path.join(artifacts, "direct-file.txt"));
  assert.deepEqual(await fs.readFile(path.join(artifacts, "direct-file.txt")), payload);
  check("새 링크 발급 및 download.html 직접 접속 다운로드");
  const beforeClear = await stats(admin);
  admin.once("dialog", dialog => dialog.dismiss());
  await admin.locator("#clear-history").click();
  assert.equal((await stats(admin)).summary.completed, beforeClear.summary.completed);
  admin.once("dialog", dialog => dialog.accept());
  await admin.locator("#clear-history").click();
  await admin.waitForFunction(() => document.getElementById("metric-completed").textContent === "0" && document.getElementById("metric-attempts").textContent === "0");
  const cleared = await stats(admin);
  assert.equal(cleared.summary.devices, 0);
  assert.equal(cleared.summary.retries, 0);
  assert.equal(cleared.summary.files, beforeClear.summary.files);
  assert.equal(cleared.summary.links, beforeClear.summary.links);
  assert.deepEqual(cleared.attempts, []);
  await user.reload();
  await user.waitForFunction(() => document.getElementById("state-badge").textContent === "수신 완료");
  assert.ok(await user.locator("#start-download").isDisabled());
  check("전체 기록 삭제 확인·취소, 누적 통계 초기화 및 완료 링크 제한 유지");
  const completedFile = cleared.files.find(file => file.name === "검증 파일.txt");
  assert.equal(completedFile.can_delete, true);
  const completedRow = admin.locator("#file-rows tr").filter({hasText: "검증 파일.txt"});
  admin.once("dialog", dialog => dialog.dismiss());
  await completedRow.getByRole("button", {name: "파일 삭제", exact: true}).click();
  assert.equal((await stats(admin)).summary.files, cleared.summary.files);
  admin.once("dialog", dialog => dialog.accept());
  await completedRow.getByRole("button", {name: "파일 삭제", exact: true}).click();
  await completedRow.waitFor({state: "hidden"});
  assert.equal((await stats(admin)).summary.files, cleared.summary.files - 1);
  await assert.rejects(fs.stat(path.join(dataDir, "files", completedFile.id)), error => error.code === "ENOENT");
  await mobile.goto(shareUrl);
  await mobile.waitForFunction(() => document.getElementById("message").textContent.includes("유효한 다운로드 링크가 아닙니다"));
  assert.ok(await mobile.locator("#download-link").evaluate(element => element.classList.contains("disabled")));
  await screenshot(admin, "admin-records-desktop");
  await login(mobile);
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(mobile, "admin-records-mobile");
  check("완료 파일 삭제 확인·취소, 서버 원본 제거 및 기존 공유 링크 차단");
  const unusedUrl = await upload(admin, "다운로드 전 삭제.txt", Buffer.from("아직 다운로드하지 않은 파일입니다.", "utf8"));
  const beforeUnusedDelete = await stats(admin);
  const unusedFile = beforeUnusedDelete.files.find(file => file.name === "다운로드 전 삭제.txt");
  assert.equal(unusedFile.completed_count, 0);
  assert.equal(unusedFile.attempt_count, 0);
  assert.equal(unusedFile.can_delete, true);
  const unusedRow = admin.locator("#file-rows tr").filter({hasText: unusedFile.name});
  assert.ok(await unusedRow.getByRole("button", {name: "파일 삭제", exact: true}).isEnabled());
  admin.once("dialog", dialog => dialog.accept());
  await unusedRow.getByRole("button", {name: "파일 삭제", exact: true}).click();
  await unusedRow.waitFor({state: "hidden"});
  await assert.rejects(fs.stat(path.join(dataDir, "files", unusedFile.id)), error => error.code === "ENOENT");
  const afterUnusedDelete = await stats(admin);
  assert.equal(afterUnusedDelete.summary.files, beforeUnusedDelete.summary.files - 1);
  assert.equal(afterUnusedDelete.summary.completed, beforeUnusedDelete.summary.completed);
  assert.equal(afterUnusedDelete.summary.attempts, beforeUnusedDelete.summary.attempts);
  await user.goto(unusedUrl);
  await user.waitForFunction(() => document.getElementById("message").textContent.includes("유효한 다운로드 링크가 아닙니다"));
  check("다운로드 이력이 없는 파일의 삭제 버튼, 목록·원본 제거 및 공유 링크 차단");
  assert.deepEqual(report.console_errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error.stack || error);
  if (browser) {
    report.failure_pages = [];
    for (const context of browser.contexts()) for (const page of context.pages()) {
      report.failure_pages.push(await page.evaluate(() => ({path: location.pathname, title: document.title, message: document.querySelector("#message, #admin-message")?.textContent, login: document.querySelector("#login-message")?.textContent, upload: document.querySelector("#upload-status")?.textContent})).catch(() => ({})));
    }
  }
  process.stderr.write(report.error + "\n");
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  // 이 검증에서 시작한 프로세스에만 종료 신호를 보냅니다.
  if (child.exitCode === null) {
    const stopMarker = path.join(dataDir, "stop.request");
    await fs.writeFile(stopMarker, "stop");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(12000)]);
    if (child.exitCode === null) child.kill();
  }
  report.shutdown_clean = runtimeOutput.includes("서버와 임시 터널을 종료했습니다.") && child.exitCode === 0;
  if (report.status === "passed" && !report.shutdown_clean) {
    report.status = "failed";
    report.error = "검증 서버가 정상 종료되지 않았습니다.";
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(artifacts, tunnelMode ? "report-tunnel.json" : "report-local.json"), JSON.stringify(report, null, 2));
  process.stdout.write("REPORT " + report.status + " · " + report.checks.length + " checks\n");
}
