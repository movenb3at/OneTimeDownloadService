export const english = {
  skip: "Skip to content",
  navigation: "Main navigation",
  language: "Choose language",
  features: "Features",
  installation: "Setup guide",
  heroTitle: "Built for one transfer.",
  heroDescription:
    "Your files stay on your PC.<br>Your link goes to the right person.<br>Simple file sharing, with one browser per link.",
  scroll: "Scroll to explore",
  singleTitle: "Share with ease.<br>Grant access once.",
  singleDescription:
    "The first browser to start a download claims the link. After reception and verification, further downloads are blocked. Even with simultaneous requests, only one browser can claim it.",
  singleNote: "Opening or previewing a link does not consume download access.",
  singleSpec: "Browser that can claim each link",
  retryTitle: "Connection lost?<br>You have 10 minutes.",
  retryDescription:
    "Cancel or lose your connection and try again in the same browser. The window lasts 10 minutes from the first start. Retries never extend it.",
  retryNote:
    "Retries start from the beginning of the file. After expiry, the administrator can issue a new link.",
  retrySpec: "Retry window from the first download start",
  integrityTitle: "Hard to predict.<br>Checked on receipt.",
  integrityDescription:
    "Share tokens are generated with SHA-256 from cryptographically secure random bytes. The receiving browser compares the file’s SHA-256 with the original before confirming completion.",
  integrityNote:
    "SHA-256 is not encryption. Anyone holding the share link has download access.",
  integritySpec: "Share token generation · File integrity verification",
  controlTitle: "Every transfer.<br>A clear view.",
  controlDescription:
    "See completions, attempts and retries separately. Check file and anonymous browser records, see each link’s remaining time, and clear history or delete source files when needed.",
  controlNote:
    "IPs are not stored in statistics. Files with a live reservation or transfer cannot be deleted.",
  controlSpec: "Administrator dashboard refresh interval",
  deployTitle: "Start on your PC.<br>Connect with a link.",
  deployDescription:
    "Run start.cmd on Windows. Your files stay on your PC while a Cloudflare temporary tunnel provides a public HTTPS address. No hosting account or domain is required.",
  deployNote:
    "Stopping the service closes the tunnel. Restarting creates a different public address.",
  deploySpec: "Maximum upload size per file",
  startTitle: "Your next transfer, with OTDS.",
  startDescription: "From setup to your first share. Get started here.",
  useNow: "Use Now",
  star: "Star GitHub Repo",
  hostingNote:
    "This website provides an introduction and setup instructions. The download service runs on your Windows PC.",
  guideTitle: "Installation & setup guide",
  guideIntro:
    "Start without a hosting account. You will need an internet connection for the first run.",
  step1Title: "Prepare your PC",
  step1:
    "You need 64-bit Windows and Python 3.11 or later. Select “Add python.exe to PATH” during installation, then check the version with the command below.",
  python: "Download Python from the official website ↗",
  step2Title: "Get the project",
  step2:
    "Download the main branch ZIP. Extract the entire folder to a writable location before running the service. Do not run it inside the ZIP archive.",
  zip: "Download project ZIP ↓",
  step2Note:
    "For example: OneTimeDownloadService inside your Documents folder.",
  step3Title: "Run the service",
  step3:
    "Double-click start.cmd in the extracted folder. The first run prepares a project-specific Python virtual environment, packages and the official cloudflared executable. Keep the console window open.",
  step3Note:
    "No global packages, Windows services or firewall settings are changed.",
  step4Title: "Set up the administrator",
  step4:
    "On the first run, enter and confirm an administrator password of at least 12 characters in the console. Your input is hidden. Open the public administrator address shown in the console and sign in.",
  step4Note:
    "The password is stored as a scrypt hash. Send a file share link to recipients, rather than your administrator address.",
  step5Title: "Share your first file",
  step5:
    "Upload a file up to 90MiB in the administrator dashboard, then copy its share link. The recipient opens the share page and proceeds to the download page. File saving is offered after full reception and SHA-256 verification.",
  step5Note:
    "Include the entire #token= fragment in the link. Completion means reception and verification in the browser; actual disk saving is not confirmed.",
  step6Title: "Manage and stop",
  step6:
    "The same browser can retry within 10 minutes of the first start. Administrators can issue new links, clear history and delete files. Press Ctrl+C in the console to stop both the server and the tunnel.",
  step6Note:
    "Copy links again after a restart changes the tunnel address. If cookies or the address change and retry access is lost, issue a new link. Files are not deleted automatically.",
  moreGuide:
    "See the repository README for local-only operation, password reset, data backup and detailed policies.",
  readme: "Full user guide ↗",
  copy: "Copy",
  copied: "Command copied.",
  copyFailed: "Copy unavailable. Select and copy the command manually.",
  title: "OTDS — Built for one transfer",
  description:
    "OTDS — One link, one browser. Self-hosted file sharing on Windows, with a 10-minute retry window, SHA-256 verification and an administrator dashboard.",
};

export function createLanguageController(onChange) {
  const korean = Object.fromEntries(
    [...document.querySelectorAll("[data-i18n]")].map((element) => [
      element.dataset.i18n,
      element.innerHTML,
    ]),
  );
  for (const element of document.querySelectorAll("[data-i18n-aria]"))
    korean[element.dataset.i18nAria] = element.getAttribute("aria-label");
  korean.title = document.title;
  korean.description = document.querySelector(
    'meta[name="description"]',
  ).content;
  korean.copied = "명령을 복사했습니다.";
  korean.copyFailed = "복사할 수 없습니다. 명령을 선택해 직접 복사해 주세요.";
  let selected = "ko";
  const storedLanguage = () => {
    try {
      return localStorage.getItem("otds-language");
    } catch {
      return null;
    }
  };
  function apply(language, updateUrl = false) {
    selected = language === "en" ? "en" : "ko";
    const dictionary = selected === "en" ? english : korean;
    document.documentElement.lang = selected;
    document.title = dictionary.title;
    document.querySelector('meta[name="description"]').content =
      dictionary.description;
    for (const element of document.querySelectorAll("[data-i18n]")) {
      // Only the fixed, local dictionaries can provide markup, for deliberate line breaks.
      element.innerHTML = dictionary[element.dataset.i18n];
    }
    for (const element of document.querySelectorAll("[data-i18n-aria]"))
      element.setAttribute("aria-label", dictionary[element.dataset.i18nAria]);
    for (const button of document.querySelectorAll("[data-language]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === selected),
      );
    for (const button of document.querySelectorAll("[data-command]"))
      button.setAttribute(
        "aria-label",
        `${dictionary.copy}: ${button.dataset.command}`,
      );
    document.getElementById("copy-status").textContent = "";
    try {
      localStorage.setItem("otds-language", selected);
    } catch {
      /* Storage may be disabled. */
    }
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set("lang", selected);
      history.replaceState(null, "", url);
    }
    onChange?.();
  }
  const fromUrl = new URL(location.href).searchParams.get("lang");
  apply(fromUrl === "en" || fromUrl === "ko" ? fromUrl : storedLanguage());
  for (const button of document.querySelectorAll("[data-language]"))
    button.addEventListener("click", () =>
      apply(button.dataset.language, true),
    );
  window.addEventListener("popstate", () =>
    apply(new URL(location.href).searchParams.get("lang") || storedLanguage()),
  );
  return { text: (key) => (selected === "en" ? english : korean)[key] };
}
