"use strict";
(async () => {
  const ids = ["file-title", "file-meta", "state-badge", "message", "start-download", "cancel-download", "save-file", "progress-area", "progress", "progress-text", "progress-percent", "reservation", "file-hash", "back-link"];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const token = OTD.token();
  let info, session, reservation, controller, busy = false, received = null, blobUrl = null, confirmationPending = false, completed = false, clockOffset = 0;
  if (!token) {
    ui["file-title"].textContent = "다운로드 링크가 없습니다";
    ui["file-meta"].textContent = "관리자가 발급한 전체 주소로 접속해 주세요.";
    OTD.badge(ui["state-badge"], "링크 없음");
    OTD.message(ui.message, "주소에 포함된 #token= 부분까지 모두 열어 주세요.", "error");
    return;
  }
  ui["back-link"].href = "/index.html#token=" + token;
  function render() {
    ui["file-title"].textContent = info.name;
    ui["file-meta"].textContent = OTD.size(info.size) + " · SHA-256 검증";
    ui["file-hash"].textContent = info.sha256;
    OTD.badge(ui["state-badge"], info.state);
    OTD.message(ui.message, OTD.stateMessage(info), info.can_download ? "" : "error");
    ui["start-download"].disabled = !info.can_download;
    ui["start-download"].textContent = info.is_owner ? "다시 다운로드" : "다운로드 시작";
    if (info.expires_at && info.is_owner) reservation = {session_id: info.session_id, expires_at: info.expires_at};
  }
  function remaining() {
    if (!reservation || completed) return;
    const seconds = Math.max(0, Math.ceil(reservation.expires_at - (Date.now() / 1000 + clockOffset)));
    ui.reservation.hidden = false;
    ui.reservation.textContent = "재시도 가능 시간 " + Math.floor(seconds / 60) + "분 " + (seconds % 60) + "초 · 재시도해도 연장되지 않습니다.";
    if (seconds === 0) {
      if (controller) controller.abort();
      ui["start-download"].disabled = true;
      OTD.badge(ui["state-badge"], "expired");
      OTD.message(ui.message, "최초 시작 후 10분이 지났습니다. 관리자에게 새 링크를 요청해 주세요.", "error");
    }
  }
  function save() {
    if (!blobUrl) return;
    const anchor = document.createElement("a");
    anchor.href = blobUrl; anchor.download = info.name;
    document.body.append(anchor); anchor.click(); anchor.remove();
  }
  async function confirm() {
    const digest = await crypto.subtle.digest("SHA-256", received);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== info.sha256) {
      await OTD.api("/api/public/downloads/" + reservation.session_id + "/complete", {
        method: "POST", csrf: session.browser_csrf, json: {sha256, size: received.byteLength}
      }).catch(() => {});
      received = null; confirmationPending = false;
      throw new Error("파일 SHA-256 검증에 실패했습니다. 다시 다운로드해 주세요.");
    }
    confirmationPending = true;
    OTD.message(ui.message, "파일 검증을 마쳤습니다. 서버에 수신 완료를 확인하고 있습니다.");
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await OTD.api("/api/public/downloads/" + reservation.session_id + "/complete", {
          method: "POST", csrf: session.browser_csrf, json: {sha256, size: received.byteLength}
        });
        break;
      } catch (error) {
        if (["expired", "revoked", "owner"].includes(error.code)) { received = null; confirmationPending = false; throw error; }
        if (attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }
    blobUrl = URL.createObjectURL(new Blob([received], {type: "application/octet-stream"}));
    received = null; confirmationPending = false; completed = true;
    info.state = "completed"; info.can_download = false;
    OTD.badge(ui["state-badge"], "completed");
    ui.reservation.hidden = true;
    ui["start-download"].hidden = true;
    ui["save-file"].hidden = false;
    ui["progress-text"].textContent = "수신 및 SHA-256 검증 완료";
    OTD.message(ui.message, "파일 수신과 검증을 완료했습니다. 저장이 시작되지 않았다면 파일 저장 버튼을 눌러 주세요.", "success");
    save();
  }
  async function start() {
    if (busy || completed) return;
    busy = true; ui["start-download"].disabled = true;
    try {
      if (confirmationPending && received) {
        await confirm();
        return;
      }
      reservation = await OTD.api("/api/public/claim", {method: "POST", csrf: session.browser_csrf, json: {token}});
      controller = new AbortController();
      ui["cancel-download"].hidden = false;
      ui["progress-area"].hidden = false;
      ui.progress.value = 0; ui["progress-percent"].textContent = "0%";
      ui["progress-text"].textContent = "파일 수신 중";
      OTD.badge(ui["state-badge"], "reserved");
      OTD.message(ui.message, "파일을 받고 있습니다. 이 브라우저에서만 재시도할 수 있습니다.");
      remaining();
      const response = await fetch("/api/public/downloads/" + reservation.session_id + "/file", {
        headers: {"X-CSRF-Token": session.browser_csrf}, credentials: "same-origin", cache: "no-store", signal: controller.signal
      });
      if (!response.ok) {
        const data = await response.json();
        throw new OTD.ApiError(data.error, response.status, data.code);
      }
      const reader = response.body.getReader();
      const bytes = new Uint8Array(info.size);
      let offset = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        if (offset + value.length > bytes.length) { await reader.cancel(); throw new Error("파일 크기가 예상과 다릅니다."); }
        bytes.set(value, offset); offset += value.length;
        const percent = info.size ? Math.round(offset / info.size * 100) : 100;
        ui.progress.value = percent; ui["progress-percent"].textContent = percent + "%";
        ui["progress-text"].textContent = OTD.size(offset) + " / " + OTD.size(info.size);
      }
      if (offset !== info.size) throw new Error("파일 수신이 중단되었습니다. 다시 시도해 주세요.");
      ui.progress.value = 100; ui["progress-percent"].textContent = "100%";
      ui["cancel-download"].hidden = true;
      controller = null;
      received = bytes;
      OTD.message(ui.message, "파일 전체를 받았습니다. SHA-256을 검증하고 있습니다.");
      await confirm();
    } catch (error) {
      if (error.name === "AbortError") OTD.message(ui.message, "다운로드를 중단했습니다. 남은 시간 안에 다시 시도할 수 있습니다.");
      else {
        const text = error instanceof TypeError ? "파일 수신 연결이 끊겼습니다. 남은 시간 안에 다시 시도해 주세요." : error.message;
        OTD.message(ui.message, confirmationPending ? "파일은 유지하고 있습니다. 수신 완료 확인을 다시 시도해 주세요. " + text : text, "error");
      }
      if (["expired", "revoked", "completed", "reserved", "owner", "file_missing"].includes(error.code)) {
        info.can_download = false;
        if (OTD.stateLabels[error.code]) OTD.badge(ui["state-badge"], error.code);
      }
      ui["start-download"].textContent = confirmationPending ? "수신 완료 확인 재시도" : "다시 다운로드";
    } finally {
      busy = false; controller = null;
      ui["cancel-download"].hidden = true;
      ui["start-download"].disabled = completed || !info.can_download || (reservation && reservation.expires_at <= Date.now() / 1000 + clockOffset);
      remaining();
    }
  }
  ui["start-download"].addEventListener("click", start);
  ui["cancel-download"].addEventListener("click", () => controller && controller.abort());
  ui["save-file"].addEventListener("click", save);
  window.addEventListener("pagehide", event => { if (blobUrl && !event.persisted) URL.revokeObjectURL(blobUrl); });
  try {
    if (!window.crypto || !crypto.subtle) throw new Error("이 브라우저에서 안전한 파일 검증을 사용할 수 없습니다. 최신 브라우저와 HTTPS 주소로 접속해 주세요.");
    session = await OTD.getSession();
    info = await OTD.api("/api/public/info", {method: "POST", json: {token}});
    clockOffset = info.server_time - Date.now() / 1000;
    render(); remaining(); setInterval(remaining, 1000);
  } catch (error) {
    ui["file-title"].textContent = "다운로드를 준비할 수 없습니다";
    ui["file-meta"].textContent = "링크와 브라우저 상태를 확인해 주세요.";
    OTD.message(ui.message, error.message, "error");
  }
})();
