import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { english } from "../src/i18n.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
const entries = await fs.readdir(root, {
  recursive: true,
  withFileTypes: true,
});
const allowed = new Set([".html", ".js", ".css", ".svg", ".ico", ".txt"]);
for (const entry of entries) {
  assert.ok(
    !entry.isSymbolicLink(),
    "Artifact must not contain symbolic links",
  );
  if (!entry.isFile()) continue;
  assert.ok(
    allowed.has(path.extname(entry.name)),
    `Unexpected artifact: ${entry.name}`,
  );
  assert.ok(
    !/(settings|service\.sqlite|password|upload|\.log|\.env)/i.test(entry.name),
    `Private artifact: ${entry.name}`,
  );
}
const html = await fs.readFile(path.join(root, "index.html"), "utf8");
const translationKeys = new Set([...html.matchAll(/data-i18n(?:-aria)?="([^\"]+)"/g)].map(match => match[1]));
for (const key of translationKeys) assert.ok(english[key], `Missing English translation: ${key}`);
for (const [, url] of html.matchAll(/(?:src|href)="(\/[^"#]*)"/g))
  assert.ok(
    url.startsWith("/OneTimeDownloadService/"),
    `Incorrect Pages path: ${url}`,
  );
assert.ok(
  !/https:\/\/[^\s"']+\.trycloudflare\.com|C:\\Users\\/.test(html),
  "Private runtime URL or local path",
);
for (const required of [
  "favicon.svg",
  "favicon.ico",
  "core.svg",
  "THIRD_PARTY_NOTICES.txt",
])
  await fs.access(path.join(root, required));
console.log(
  `PASS public Pages artifact: ${entries.filter((entry) => entry.isFile()).length} files`,
);
