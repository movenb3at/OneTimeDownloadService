"use strict";
(async () => {
  const $ = id => document.getElementById(id);
  let session, polling, countdownTimer, refreshing = null, uploading = false, actionBusy = false;
  let countdowns = [], serverClock = 0, clockStarted = 0;
  function notify(text, kind = "") { OTD.message($("admin-message"), text, kind); }
  function td(text, className = "") {
    const element = document.createElement("td"); element.textContent = text; element.className = className; return element;
  }
  function titleCell(title, detail) {
    const cell = td(""); const main = document.createElement("span"); main.className = "cell-title"; main.textContent = title;
    const sub = document.createElement("span"); sub.className = "cell-detail"; sub.textContent = detail;
    cell.append(main, sub); return cell;
  }
  function button(text, action, dangerous = false) {
    const element = document.createElement("button"); element.type = "button";
    element.className = "button small secondary" + (dangerous ? " danger" : ""); element.textContent = text;
    element.addEventListener("click", async () => {
      if (actionBusy || uploading) return;
      actionBusy = true; element.disabled = true;
      try { await action(); } catch (error) { notify(error.message, "error"); if (error.status === 401) showLogin(); }
      finally { actionBusy = false; element.disabled = false; }
    });
    return element;
  }
  function fill(id, rows, columns, build) {
    const container = $(id); container.replaceChildren();
    if (!rows.length) {
      const row = document.createElement("tr"), cell = td("아직 기록이 없습니다.", "empty");
      cell.colSpan = columns; row.append(cell); container.append(row); return;
    }
    rows.forEach(value => { const row = document.createElement("tr"); row.append(...build(value)); container.append(row); });
  }
  function showLogin() {
    clearInterval(polling); clearInterval(countdownTimer); countdowns = [];
    $("dashboard").hidden = true; $("login-panel").hidden = false; $("logout").hidden = true;
  }
  function issued(url) {
    $("issued-link").hidden = false; $("latest-link").value = url;
  }
  function updateCountdowns() {
    const serverNow = serverClock + (performance.now() - clockStarted) / 1000;
    for (const {link, cell, badge, revoke} of countdowns) {
      if (link.state !== "reserved") {
        cell.textContent = link.state === "available" ? "시작 전 · 제한 없음" : OTD.stateLabels[link.state] || "—";
        continue;
      }
      const seconds = Math.max(0, Math.ceil(link.expires_at - serverNow));
      cell.className = "link-remaining" + (seconds ? " active" : " danger");
      cell.textContent = seconds ? String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0") : "시간 만료";
      OTD.badge(badge, seconds ? "reserved" : "expired");
      if (revoke && seconds === 0) revoke.disabled = true;
    }
  }
  function render(data) {
    serverClock = data.server_time; clockStarted = performance.now(); countdowns = [];
    for (const metric of ["completed", "attempts", "retries", "reserved", "devices"]) $("metric-" + metric).textContent = data.summary[metric].toLocaleString("ko-KR");
    $("updated").textContent = "갱신 " + OTD.date(data.server_time);
    $("file-count").textContent = data.summary.files + "개 파일";
    $("statistics-reset").textContent = data.statistics_reset_at ? "최근 초기화: " + OTD.date(data.statistics_reset_at) : "전체 기간의 기록을 표시하고 있습니다.";
    const labels = {ready: "터널 연결됨", starting: "연결 중", failed: "연결 실패", stopped: "연결 종료", local: "로컬 실행"};
    $("tunnel-badge").textContent = labels[data.tunnel.status] || "확인 중";
    $("tunnel-badge").className = "badge" + (data.tunnel.status === "failed" ? " error" : "");
    $("public-url").textContent = data.tunnel.public_url || "공개 주소가 준비되지 않았습니다.";
    $("tunnel-message").textContent = data.tunnel.message || "로컬 관리자 주소: " + data.tunnel.local_url + "/admin.html";
    fill("file-rows", data.files, 6, file => {
      const actions = td(""), group = document.createElement("div"); group.className = "table-actions";
      group.append(button("새 링크 발급", async () => {
        const result = await OTD.api("/api/admin/files/" + file.id + "/links", {method: "POST", csrf: session.admin_csrf});
        issued(result.share_url); notify("새 공유 링크를 발급했습니다.", "success"); await refreshAfterAction();
      }));
      const remove = button("파일 삭제", async () => {
        if (!window.confirm('"' + file.name + '" 파일을 서버에서 삭제하시겠습니까?\n이 파일의 모든 공유 링크를 사용할 수 없게 됩니다. 기존 통계와 기록은 유지됩니다.')) return;
        await OTD.api("/api/admin/files/" + file.id, {method: "DELETE", csrf: session.admin_csrf});
        $("issued-link").hidden = true; $("latest-link").value = "";
        notify("파일을 삭제했습니다. 기존 통계와 다운로드 기록은 유지됩니다.", "success"); await refreshAfterAction();
      }, true);
      remove.disabled = !file.can_delete; remove.title = file.delete_reason || "서버에 보관된 파일 삭제";
      group.append(remove); actions.append(group);
      return [titleCell(file.name, OTD.date(file.created_at)), td(OTD.size(file.size)), td(file.completed_count), td(file.attempt_count), td(file.link_count), actions];
    });
    fill("link-rows", data.links, 6, link => {
      const badge = document.createElement("span"); OTD.badge(badge, link.state);
      const status = td(""); status.append(badge);
      if (link.expires_at && link.state === "reserved") { const detail = document.createElement("span"); detail.className = "cell-detail"; detail.textContent = "만료 " + OTD.date(link.expires_at); status.append(detail); }
      const remaining = td("", "link-remaining");
      const actions = td(""); const group = document.createElement("div"); group.className = "table-actions";
      group.append(button("링크 복사", async () => { await OTD.copy(link.share_url); notify("현재 주소의 공유 링크를 복사했습니다."); }));
      let revoke = null;
      if (["available", "reserved"].includes(link.state)) {
        revoke = button("무효화", async () => {
          await OTD.api("/api/admin/links/" + link.id + "/revoke", {method: "POST", csrf: session.admin_csrf});
          notify("링크를 무효화했습니다."); await refreshAfterAction();
        }, true);
        group.append(revoke);
      }
      countdowns.push({link, cell: remaining, badge, revoke});
      actions.append(group);
      return [titleCell(link.name, OTD.date(link.created_at)), status, remaining, td(link.device_id || "—"), td(link.attempt_count), actions];
    });
    updateCountdowns();
    fill("device-rows", data.devices, 6, device => [
      titleCell(device.id, "첫 방문 " + OTD.date(device.first_seen)), td(device.device_type), td(device.os + " · " + device.browser),
      td(OTD.date(device.last_seen)), td(device.attempt_count), td(device.completed_count)
    ]);
    fill("attempt-rows", data.attempts, 5, attempt => [
      td(OTD.date(attempt.started_at)), titleCell(attempt.name, attempt.finished_at ? "처리 종료 " + OTD.date(attempt.finished_at) : "처리 중"),
      titleCell(attempt.device_id, attempt.os + " · " + attempt.browser),
      td(OTD.attemptLabels[attempt.status] || attempt.status), td(OTD.size(attempt.bytes_sent))
    ]);
  }
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try { render(await OTD.api("/api/admin/dashboard")); }
      catch (error) { if (error.status === 401) { showLogin(); OTD.message($("login-message"), "로그인이 만료되었습니다. 다시 로그인해 주세요."); } else notify("현황을 갱신하지 못했습니다. " + error.message, "error"); }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function refreshAfterAction() {
    if (refreshing) await refreshing;
    await refresh();
  }
  async function showDashboard() {
    $("login-panel").hidden = true; $("dashboard").hidden = false; $("logout").hidden = false;
    await refresh();
    if ($("dashboard").hidden) return;
    clearInterval(polling); polling = setInterval(() => { if (!document.hidden && !actionBusy) refresh(); }, 5000);
    clearInterval(countdownTimer); countdownTimer = setInterval(() => { if (!document.hidden) updateCountdowns(); }, 1000);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !$("dashboard").hidden) {
      updateCountdowns();
      if (!actionBusy) refresh();
    }
  });
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault(); $("login-button").disabled = true;
    try {
      session = await OTD.getSession(true);
      const result = await OTD.api("/api/admin/login", {method: "POST", csrf: session.browser_csrf, json: {password: $("password").value}});
      $("password").value = ""; session.admin_csrf = result.admin_csrf; await showDashboard();
    } catch (error) { OTD.message($("login-message"), error.message, "error"); }
    finally { $("login-button").disabled = false; }
  });
  $("logout").addEventListener("click", async () => {
    try { await OTD.api("/api/admin/logout", {method: "POST", csrf: session.admin_csrf}); showLogin(); }
    catch (error) { notify(error.message, "error"); }
  });
  $("upload-file").addEventListener("change", () => {
    const file = $("upload-file").files[0];
    $("selected-file").textContent = file ? file.name + " · " + OTD.size(file.size) : "파일을 선택해 주세요";
  });
  $("copy-latest").addEventListener("click", async () => {
    try { await OTD.copy($("latest-link").value); notify("공유 링크를 복사했습니다."); }
    catch (error) { notify(error.message, "error"); }
  });
  $("clear-history").addEventListener("click", async () => {
    if (actionBusy || uploading) return;
    if (!window.confirm("전체 통계와 기기별·다운로드 기록을 삭제하시겠습니까?\n삭제한 기록은 복구할 수 없습니다. 파일, 공유 링크와 현재 예약은 유지됩니다.")) return;
    actionBusy = true; $("clear-history").disabled = true;
    try {
      await OTD.api("/api/admin/history/clear", {method: "POST", csrf: session.admin_csrf});
      notify("전체 기록을 삭제하고 누적 통계를 초기화했습니다.", "success"); await refreshAfterAction();
    } catch (error) { notify(error.message, "error"); if (error.status === 401) showLogin(); }
    finally { actionBusy = false; $("clear-history").disabled = false; }
  });
  $("upload-form").addEventListener("submit", event => {
    event.preventDefault();
    if (uploading || actionBusy) return;
    const file = $("upload-file").files[0];
    if (!file) return;
    if (file.size > session.max_file_size) { notify("파일은 최대 90MiB까지 업로드할 수 있습니다.", "error"); return; }
    uploading = true; $("upload-button").disabled = true; $("clear-history").disabled = true; $("upload-progress").hidden = false; $("upload-progress").value = 0;
    $("upload-status").textContent = "업로드 중입니다.";
    const form = new FormData(); form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/files"); xhr.setRequestHeader("X-CSRF-Token", session.admin_csrf);
    xhr.upload.addEventListener("progress", progress => { if (progress.lengthComputable) $("upload-progress").value = progress.loaded / progress.total * 100; });
    const finish = () => { uploading = false; $("upload-button").disabled = false; $("clear-history").disabled = false; };
    xhr.addEventListener("load", async () => {
      finish();
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(result.error || "업로드에 실패했습니다.");
        issued(result.share_url); $("upload-status").textContent = "업로드와 SHA-256 계산을 완료했습니다.";
        $("upload-form").reset(); $("selected-file").textContent = "파일을 선택해 주세요";
        notify("파일을 업로드하고 공유 링크를 발급했습니다.", "success"); await refreshAfterAction();
      } catch (error) { $("upload-status").textContent = "업로드하지 못했습니다."; notify(error.message, "error"); }
    });
    xhr.addEventListener("error", () => { finish(); $("upload-status").textContent = "연결이 끊겼습니다."; notify("업로드 연결을 확인해 주세요.", "error"); });
    xhr.send(form);
  });
  try { session = await OTD.getSession(); if (session.admin) await showDashboard(); }
  catch (error) { OTD.message($("login-message"), error.message, "error"); }
})();
