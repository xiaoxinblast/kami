import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("左侧导航新增参考资料页，且排在双语资产导入之后", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /data-view="references"/u);
  assert.match(html, /id="view-references"/u);
  assert.match(html, /id="referenceFileInput"/u);
  assert.match(html, /id="referenceList"/u);
  assert.match(html, /id="referenceDetailPanel"/u);
  const importIndex = html.indexOf('data-view="import"');
  const referenceIndex = html.indexOf('data-view="references"');
  const assetsIndex = html.indexOf('data-view="assets"');
  assert.ok(importIndex > 0 && referenceIndex > importIndex, "参考资料应排在双语资产导入之后");
  assert.ok(assetsIndex > referenceIndex, "参考资料应排在术语库之前");
});

test("参考资料页接好了加载、上传、详情与操作入口", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const symbol of ["loadReferences", "renderReferenceList", "uploadReferenceFiles", "openReferenceDetail", "referenceAction"]) {
    assert.match(script, new RegExp(symbol, "u"));
  }
  assert.match(script, /view === "references"/u);
  assert.match(script, /"\/api\/references"/u);
  assert.match(script, /\/api\/reference-chunks\//u);
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.reference-row/u);
  assert.match(styles, /\.reference-chunk/u);
});
