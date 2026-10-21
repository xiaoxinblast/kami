import { Worker } from "node:worker_threads";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 术语匹配 worker 池（当前单 worker，够把事件循环让出来）。
 *
 * 调用方 `await pool.match(text, assets, options)`；资产按对象身份生成 token，
 * worker 只第一次收到整份术语库。worker 启动失败/超时/退出时 Promise 会 reject，
 * 调用方自行回退同步 matchTerms，保证不影响出译文。
 */
export function createMatcherPool({ workerUrl = new URL("./matcher-worker.mjs", import.meta.url), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();
  const sentAssets = new Set();
  const assetTokens = new WeakMap();
  let tokenSequence = 0;

  const tokenFor = (assets) => {
    if (!assets || typeof assets !== "object") return "none";
    let token = assetTokens.get(assets);
    if (!token) {
      token = `assets-${++tokenSequence}`;
      assetTokens.set(assets, token);
    }
    return token;
  };

  const failPending = (error) => {
    const entries = [...pending.values()];
    pending.clear();
    sentAssets.clear();
    worker = null;
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  };

  const ensureWorker = () => {
    if (worker) return worker;
    worker = new Worker(workerUrl);
    // 不阻止进程退出；需要时 close() 会 terminate。
    worker.unref?.();
    worker.on("message", (message) => {
      const entry = pending.get(message?.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.matches);
    });
    worker.on("error", (error) => failPending(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => failPending(new Error(`matcher worker exited (${code})`)));
    return worker;
  };

  return {
    match(text, assets, options = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const assetsToken = tokenFor(assets);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("matcher worker timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          const message = { type: "match", id, text, options, assetsToken };
          if (!sentAssets.has(assetsToken)) {
            message.assets = assets;
            sentAssets.add(assetsToken);
          }
          ensureWorker().postMessage(message);
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    async close() {
      const current = worker;
      worker = null;
      sentAssets.clear();
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      await current?.terminate().catch(() => {});
    }
  };
}
