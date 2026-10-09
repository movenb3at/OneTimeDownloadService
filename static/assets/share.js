"use strict";
(async () => {
  const ui = Object.fromEntries(["file-title", "file-meta", "state-badge", "message", "download-link", "copy-link"].map(id => [id, document.getElementById(id)]));
  const token = OTD.token();
  if (!token) {
    ui["file-title"].textContent = "공유 링크로 접속해 주세요";
    ui["file-meta"].textContent = "관리자가 발급한 전체 주소가 필요합니다.";
    OTD.badge(ui["state-badge"], "링크 없음");
    OTD.message(ui.message, "주소에 포함된 #token= 부분까지 모두 열어 주세요.");
    return;
  }
  try {
    await OTD.getSession();
    const info = await OTD.api("/api/public/info", {method: "POST", json: {token}});
    ui["file-title"].textContent = info.name;
    ui["file-meta"].textContent = OTD.size(info.size) + " · 한 브라우저에서 한 번 수신";
    OTD.badge(ui["state-badge"], info.state);
    OTD.message(ui.message, OTD.stateMessage(info), info.can_download ? "" : "error");
    ui["download-link"].href = "/download.html#token=" + token;
    ui["download-link"].classList.remove("disabled");
    ui["download-link"].removeAttribute("aria-disabled");
    ui["copy-link"].disabled = false;
    ui["copy-link"].addEventListener("click", async () => {
      try {
        await OTD.copy(location.origin + "/index.html#token=" + token);
        OTD.message(ui.message, "공유 링크를 복사했습니다.");
      } catch (error) { OTD.message(ui.message, error.message, "error"); }
    });
  } catch (error) {
    ui["file-title"].textContent = "파일을 확인할 수 없습니다";
    ui["file-meta"].textContent = "공유 주소를 확인해 주세요.";
    OTD.badge(ui["state-badge"], "유효하지 않은 링크");
    OTD.message(ui.message, error.message, "error");
  }
})();
