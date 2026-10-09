"use strict";
const loadedHash = location.hash;
window.addEventListener("hashchange", () => {
  if (location.hash !== loadedHash) location.reload();
});
window.OTD = (() => {
  const stateLabels = {available: "다운로드 가능", reserved: "예약 중", completed: "수신 완료", expired: "시간 만료", revoked: "무효화"};
  const attemptLabels = {streaming: "전송 중", awaiting_confirmation: "수신 확인 대기", interrupted: "전송 중단", hash_mismatch: "해시 불일치", expired: "시간 만료", revoked: "무효화", completed: "수신 완료"};
  let session = null;
  let sessionRequest = null;
  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.json !== undefined) { headers.set("Content-Type", "application/json"); options.body = JSON.stringify(options.json); }
    if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
    let response;
    try { response = await fetch(path, {...options, headers, credentials: "same-origin", cache: "no-store"}); }
    catch (error) {
      if (error.name === "AbortError") throw error;
      throw new ApiError("서버 연결이 끊겼습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.", 0, "network");
    }
    let data;
    try { data = await response.json(); } catch (_) { throw new ApiError("서버 응답을 확인할 수 없습니다. 연결 상태를 확인해 주세요.", response.status, "response"); }
    if (!response.ok) throw new ApiError(data.error || "요청을 처리하지 못했습니다.", response.status, data.code);
    return data;
  }
  async function getSession(refresh = false) {
    if (sessionRequest) return sessionRequest;
    if (!session || refresh) {
      sessionRequest = api("/api/session").then(data => { session = data; return data; });
      try { return await sessionRequest; }
      finally { sessionRequest = null; }
    }
    return session;
  }
  function token() {
    const value = new URLSearchParams(location.hash.slice(1)).get("token") || "";
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  }
  function size(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KiB", "MiB", "GiB"];
    const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, unit)).toLocaleString("ko-KR", {maximumFractionDigits: unit ? 1 : 0}) + " " + units[unit];
  }
  function date(value) {
    return value ? new Date(value * 1000).toLocaleString("ko-KR", {timeZone: "Asia/Seoul", hour12: false}) : "—";
  }
  function message(element, text, kind = "") {
    element.textContent = text; element.className = "notice" + (kind ? " " + kind : ""); element.hidden = false;
  }
  function badge(element, state) {
    element.textContent = stateLabels[state] || state;
    element.className = "badge" + (["expired", "revoked"].includes(state) ? " error" : state === "completed" ? " neutral" : "");
  }
  function stateMessage(info) {
    if (info.state === "available") return "아직 사용되지 않은 링크입니다. 다운로드 시작 후에는 한 브라우저에 예약됩니다.";
    if (info.state === "reserved") return info.is_owner ? "이 브라우저에 예약된 링크입니다. 최초 시작 후 10분 안에 다시 받을 수 있습니다." : "다른 브라우저가 다운로드를 시작했습니다. 관리자에게 새 링크를 요청해 주세요.";
    if (info.state === "completed") return "이미 파일 수신과 검증이 완료된 링크입니다. 관리자에게 새 링크를 요청해 주세요.";
    if (info.state === "expired") return "최초 시작 후 10분이 지나 링크가 만료되었습니다. 관리자에게 새 링크를 요청해 주세요.";
    return "관리자가 무효화한 링크입니다. 관리자에게 새 링크를 요청해 주세요.";
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const input = document.createElement("textarea");
      input.value = text; input.setAttribute("aria-label", "복사할 링크");
      document.body.append(input); input.select();
      const copied = document.execCommand("copy"); input.remove();
      if (!copied) throw new Error("링크를 직접 선택해 복사해 주세요.");
    }
  }
  return {api, getSession, token, size, date, message, badge, stateMessage, copy, stateLabels, attemptLabels, ApiError};
})();
