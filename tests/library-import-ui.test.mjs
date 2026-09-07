import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("术语库和风格指导页面提供各自的上传入口", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /id="termLibraryFile"[^>]+accept="\.xlsx,\.csv"/u);
  assert.match(html, /id="styleGuideFile"[^>]+accept="\.txt,\.md,\.docx"/u);
  assert.match(html, /id="styleGuideImportButton"/u);
  assert.match(script, /setImportFiles\(files, \{ intent: "terms", returnView: "assets" \}\)/u);
  assert.match(script, /api\("\/api\/style-guides\/import"/u);
  assert.doesNotMatch(html, /name="enforcement"/u);
});
