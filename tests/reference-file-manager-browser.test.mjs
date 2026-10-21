import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONTENT_TYPES, CONTENT_TAGS, LOCALES } from "../src/config.mjs";
import { createDefaultProjectSettings } from "../src/project-config.mjs";
import { waitForText } from "./fixtures/browser-wait.mjs";

function documentRecord(id, folderId, name) {
  return {
    id,
    projectId: "project-1",
    folderId,
    name,
    sourceFile: `${name}.txt`,
    sourceFormat: "txt",
    status: "ready",
    characters: 12,
    chunkCount: 1,
    contentType: "",
    domain: "",
    ingestReport: { format: "txt", stage: "ready", bytes: 12, pages: 1 }
  };
}

test("参考资料文件树支持目录切换、勾选、批量扫描、拖拽上传与站内移动", { skip: !process.env.KAMI_BROWSER_TEST_MODULE, timeout: 90000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.KAMI_BROWSER_TEST_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.KAMI_BROWSER_EXECUTABLE ? { executablePath: process.env.KAMI_BROWSER_EXECUTABLE } : {}) });
  const server = createServer(async (req, res) => {
    const pathname = req.url === "/" ? "/index.html" : req.url;
    const extension = pathname.split(".").at(-1);
    try {
      const body = await readFile(new URL(`../public${pathname}`, import.meta.url));
      res.setHeader("content-type", ({ html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml" })[extension] || "application/octet-stream");
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const requests = [];
  let describeBatch = null;
  const folders = [
    { id: "folder-a", projectId: "project-1", parentId: "", name: "设定集", documentCount: 2 },
    { id: "folder-b", projectId: "project-1", parentId: "folder-a", name: "角色", documentCount: 0 }
  ];
  const documents = {
    "": [documentRecord("doc-root", "", "总览")],
    "folder-a": [documentRecord("doc-a1", "folder-a", "角色设定"), documentRecord("doc-a2", "folder-a", "剧情顺序")]
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      let payload = {};
      let status = 200;
      requests.push({ method: request.method(), path, query: Object.fromEntries(url.searchParams), body: request.postData() || "" });
      if (path === "/api/bootstrap") payload = {
        locales: { "zh-CN": LOCALES["zh-CN"] }, contentTypes: CONTENT_TYPES, contentTags: CONTENT_TAGS,
        provider: { model: "test", baseUrl: "http://127.0.0.1/v1" }, backend: {}, assets: { "zh-CN": { revision: 0, termCount: 0 } }
      };
      else if (path === "/api/health") payload = { ok: true, version: "0.7.0" };
      else if (path === "/api/projects") payload = { projects: [{ id: "project-1", name: "测试项目", settings: createDefaultProjectSettings() }] };
      else if (path === "/api/projects/project-1/libraries") payload = { libraries: [] };
      else if (path === "/api/assets") payload = { locale: "zh-CN", revision: 0, terms: [] };
      else if (path === "/api/memories") payload = { memories: [], total: 0 };
      else if (path === "/api/feedback/pending" || path === "/api/feedback") payload = [];
      else if (path === "/api/qa-cases/pending") payload = [];
      else if (path === "/api/tasks") payload = { tasks: [], total: 0 };
      else if (path === "/api/style-profiles") payload = { styleProfiles: [], evidencePools: [], learningRuns: [], userProfiles: [] };
      else if (path === "/api/reference-folders") payload = { items: folders };
      else if (path === "/api/references/file") {
        status = 202;
        payload = { taskId: "ingest-1", backgroundTaskId: "ingest-1", documentId: "doc-new", folderId: url.searchParams.get("folderId") || "" };
      }
      else if (path === "/api/background-tasks/ingest-1") payload = { id: "ingest-1", taskType: "reference_ingest", status: "completed", progress: { message: "资料已就绪", percent: 100, completed: 1, total: 1 } };
      else if (path === "/api/background-tasks/describe-1") payload = { id: "describe-1", taskType: "reference_describe", status: "completed", progress: { message: "AI 扫描完成", percent: 100, completed: 2, total: 2 } };
      else if (path === "/api/references/describe-batch") {
        status = 202;
        describeBatch = JSON.parse(request.postData() || "{}");
        payload = { taskId: "describe-1", total: describeBatch.documentIds?.length || 0, skipped: 0 };
      }
      else if (path === "/api/references/doc-a1" && request.method() === "PATCH") {
        payload = { document: documentRecord("doc-a1", JSON.parse(request.postData() || "{}").folderId, "角色设定") };
      }
      else if (path === "/api/references") {
        const folderId = url.searchParams.get("folderId") || "";
        payload = { items: documents[folderId] || [], total: (documents[folderId] || []).length, libraries: [] };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('button[data-view="references"]').click();
    await waitForText(page.locator("#referenceTree"), /设定集/u);
    await page.locator('[data-reference-tree-toggle="folder-a"]').click();
    assert.match(await page.locator("#referenceTree").textContent(), /角色/u, "二级目录要出现在树里");

    await page.locator('[data-reference-folder-open="folder-a"]').click();
    await waitForText(page.locator("#referenceList"), /角色设定/u);
    assert.equal(await page.locator("#referenceList .reference-row").count(), 2);
    assert.ok(requests.some((item) => item.path === "/api/references" && item.query.folderId === "folder-a"), "打开目录要带 folderId");
    await waitForText(page.locator("#referenceSelectionBar"), /已选 0 项/u);
    assert.equal(await page.locator("#referenceSelectAll").isEnabled(), true, "没有勾选时全选也要可用");
    assert.equal(await page.locator("#referenceBatchDescribe").isDisabled(), true, "没有勾选时批量扫描不可用");
    assert.match(await page.locator("#referenceRootDropZone").textContent(), /拖入这里导入到项目根目录/u);

    await page.locator('[data-reference-folder-select="folder-b"]').check();
    await page.locator('[data-reference-select="doc-a1"]').check();
    await waitForText(page.locator("#referenceSelectionBar"), /已选 2 项/u);
    await page.locator("#referenceBatchDescribe").click();
    await waitForText(page.locator("#toast"), /已开始批量 AI 扫描/u);
    assert.deepEqual(describeBatch?.documentIds?.sort(), ["doc-a1"]);
    assert.deepEqual(describeBatch?.folderIds?.sort(), ["folder-b"]);

    await page.locator("#referenceSelectAll").click();
    await waitForText(page.locator("#referenceSelectionBar"), /已选 3 项/u);
    await page.locator("#referenceBatchDescribe").click();
    assert.deepEqual(describeBatch?.documentIds?.sort(), ["doc-a1", "doc-a2"]);
    assert.deepEqual(describeBatch?.folderIds?.sort(), ["folder-b"]);

    // 拖到现有文件夹上时，覆盖提示要明确写出目标目录。
    await page.evaluate(() => {
      const zone = document.querySelector("#referenceDropZone");
      const folder = document.querySelector('#referenceList [data-reference-folder-id="folder-b"]');
      const transfer = new DataTransfer();
      transfer.items.add(new File(["role"], "角色补充.txt", { type: "text/plain" }));
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      folder.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await waitForText(page.locator("#referenceDropOverlayTitle"), /导入到「角色」/u);
    assert.equal(await page.locator('#referenceList [data-reference-folder-id="folder-b"]').evaluate((element) => element.classList.contains("reference-drop-target")), true);
    await page.evaluate(() => {
      const zone = document.querySelector("#referenceDropZone");
      zone.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget: null }));
    });
    await page.waitForFunction(() => document.querySelector("#referenceDropOverlay")?.hidden === true);

    // 取消拖拽时浏览器可能不给 dragend：安全超时必须把提示自动收掉。
    await page.evaluate(() => {
      const zone = document.querySelector("#referenceDropZone");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["cancel"], "取消拖拽.txt", { type: "text/plain" }));
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await waitForText(page.locator("#referenceDropOverlay"), /导入到/u);
    await page.waitForFunction(() => document.querySelector("#referenceDropOverlay")?.hidden === true, null, { timeout: 5000 });

    // 站内拖动：把勾选的资料拖到根目录，必须发出 PATCH。
    await page.evaluate(() => {
      const source = document.querySelector('[data-reference-id="doc-a1"]');
      const target = document.querySelector('#referenceTree [data-reference-folder-id=""]');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await waitForText(page.locator("#toast"), /已移动/u);
    assert.ok(requests.some((item) => item.path === "/api/references/doc-a1" && item.method === "PATCH" && JSON.parse(item.body || "{}").folderId === ""), "拖到根目录要改 folderId");

    // 外部拖入：先显示覆盖提示，且根目录有明确落点。
    await page.evaluate(() => {
      const zone = document.querySelector("#referenceDropZone");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["root"], "根目录资料.txt", { type: "text/plain" }));
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await waitForText(page.locator("#referenceDropOverlay"), /导入到「设定集」/u);
    await page.evaluate(() => {
      const target = document.querySelector("#referenceRootDropZone");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["root"], "根目录资料.txt", { type: "text/plain" }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await waitForText(page.locator("#referenceDropOverlayTitle"), /文件拖入这里导入/u);
    assert.match(await page.locator("#referenceDropOverlayTarget").textContent(), /根目录/u);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/reference-drag-overlay.png`, animations: "disabled" });
    }
    await page.evaluate(() => {
      const target = document.querySelector("#referenceRootDropZone");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["root"], "根目录资料.txt", { type: "text/plain" }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await waitForText(page.locator("#referenceUploadNote"), /已提交/u);
    assert.ok(requests.some((item) => item.path === "/api/references/file" && item.query.filename === "根目录资料.txt" && item.query.folderId === ""), "根目录落点要上传到根目录");

    // 外部拖入文件：按当前目录直接上传原始字节。
    await page.evaluate(() => {
      const zone = document.querySelector("#referenceDropZone");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["hello"], "新增设定.txt", { type: "text/plain" }));
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => document.querySelector("#referenceUploadNote")?.textContent?.includes("已提交") || false);
    assert.ok(requests.some((item) => item.path === "/api/references/file" && item.query.filename === "新增设定.txt" && item.query.folderId === "folder-a"), "拖入文件要落在当前目录");
    assert.deepEqual(errors, []);
    if (process.env.KAMI_UI_SCREENSHOTS) {
      await mkdir(process.env.KAMI_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/reference-file-manager.png`, fullPage: true, animations: "disabled" });
      await page.setViewportSize({ width: 900, height: 1000 });
      await page.screenshot({ path: `${process.env.KAMI_UI_SCREENSHOTS}/reference-file-manager-narrow.png`, fullPage: true, animations: "disabled" });
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
