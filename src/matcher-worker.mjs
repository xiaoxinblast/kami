import { parentPort } from "node:worker_threads";

import { matchTerms } from "./matcher.mjs";

/**
 * 术语匹配 worker：主线程只负责收发，5,800+ 条术语的滑窗匹配不再占住事件循环。
 *
 * 术语资产按 token 缓存（主线程用资产对象身份生成 token）；同一份资产只传一次。
 * 保留少量旧 token，避免术语库刷新后 worker 内存无限增长。
 */
const assetsByToken = new Map();
const MAX_CACHED_ASSETS = 4;

parentPort?.on("message", (message) => {
  if (!message || message.type !== "match") return;
  const { id, text, options = {}, assetsToken } = message;
  try {
    if (message.assets) {
      assetsByToken.set(assetsToken, message.assets);
      while (assetsByToken.size > MAX_CACHED_ASSETS) {
        assetsByToken.delete(assetsByToken.keys().next().value);
      }
    }
    const assets = assetsByToken.get(assetsToken);
    if (!assets) throw new Error("worker 缺少术语资产");
    const matches = matchTerms(String(text || ""), assets, options || {});
    parentPort.postMessage({ id, matches });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
