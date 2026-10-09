import { createLanguageController } from "./i18n.js";

const guide = document.getElementById("guide");
let core;
const language = createLanguageController(() => core?.refresh());
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
let syncingGuide = false;

function syncGuide(scroll = false, behavior = motion.matches ? "instant" : "smooth") {
  const shouldOpen = location.hash === "#guide";
  syncingGuide = true;
  guide.open = shouldOpen;
  syncingGuide = false;
  if (shouldOpen && scroll)
    requestAnimationFrame(() =>
      guide.scrollIntoView({
        behavior,
        block: "start",
      }),
    );
}
for (const link of document.querySelectorAll(".guide-link"))
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (location.hash !== "#guide") history.pushState(null, "", "#guide");
    syncGuide(true);
  });
guide.addEventListener("toggle", () => {
  if (syncingGuide || guide.open === (location.hash === "#guide")) return;
  const url = new URL(location.href);
  if (guide.open) url.hash = "guide";
  else url.hash = "";
  history.pushState(null, "", url);
  core?.refresh();
});
window.addEventListener("hashchange", () =>
  syncGuide(location.hash === "#guide"),
);
window.addEventListener("popstate", () => syncGuide());
syncGuide(location.hash === "#guide", "instant");

for (const button of document.querySelectorAll(".copy-command"))
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.command);
      document.getElementById("copy-status").textContent =
        language.text("copied");
    } catch {
      document.getElementById("copy-status").textContent =
        language.text("copyFailed");
    }
  });

// Keep the text and guide usable even if the 3D module fails to load.
let loadingCore = false;
async function loadCore() {
  if (motion.matches || core || loadingCore) return;
  loadingCore = true;
  try {
    const { createCore } = await import("./core.js");
    if (!motion.matches) core = createCore();
  } catch {
    document.querySelector(".scene").dataset.mode = "static";
  } finally {
    loadingCore = false;
  }
}
motion.addEventListener("change", () => {
  if (motion.matches) {
    core?.dispose();
    core = undefined;
  } else loadCore();
});
loadCore();

const chapters = [...document.querySelectorAll("[data-stage]")];
const scene = document.querySelector(".scene");
function updateChapter() {
  const halfway = innerHeight * 0.5;
  let stage = 0;
  for (const section of chapters)
    if (section.getBoundingClientRect().top <= halfway)
      stage = Number(section.dataset.stage);
  document.getElementById("chapter-number").textContent = String(
    stage + 1,
  ).padStart(2, "0");
  const story = document.getElementById("story");
  const progress = Math.max(
    0,
    Math.min(1, scrollY / (story.offsetHeight - innerHeight)),
  );
  document.getElementById("chapter-progress").style.height =
    `${progress * 100}%`;
  const visible = story.getBoundingClientRect().bottom > 0;
  scene.style.opacity = visible ? "1" : "0";
  document.querySelector(".chapter-indicator").style.opacity = visible
    ? "1"
    : "0";
}
window.addEventListener("scroll", updateChapter, { passive: true });
window.addEventListener("resize", updateChapter);
updateChapter();
