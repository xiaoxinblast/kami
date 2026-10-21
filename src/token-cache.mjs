/**
 * 带「资源代际」的 TTL 缓存。
 *
 * 用法：每次读取时传入一个便宜的代际 token（例如术语写入计数）。token 变了就重新加载，
 * 即使 TTL 还没到；token 不变时最多缓存 ttlMs。用于「大多数时候命中、写入后立刻刷新」
 * 的只读数据（项目术语库、参考资料索引等）。
 */
export function createTokenCache({ ttlMs = 30_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  const ttl = Math.max(0, Number(ttlMs) || 0);
  return {
    async get(key, token, load) {
      const entry = entries.get(key);
      if (entry && entry.token === token && now() - entry.at < ttl) return entry.value;
      const value = await load();
      entries.set(key, { token, at: now(), value });
      return value;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    }
  };
}
