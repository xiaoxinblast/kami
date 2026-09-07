const HEARTBEAT_INTERVAL_MS = 5_000;

function createSessionId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function postSession(path, sessionId) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionId }),
    keepalive: true
  }).catch(() => {});
}

/** 为每个浏览器标签页登记存活状态，供启动器模式的自动收尾使用。 */
export function startWorkbenchSession() {
  const sessionId = createSessionId();
  let pageHidden = false;
  const heartbeat = () => postSession("/api/workbench-session", sessionId);
  const close = () => {
    if (pageHidden) return;
    pageHidden = true;
    const body = JSON.stringify({ id: sessionId });
    const delivered = navigator.sendBeacon?.("/api/workbench-session/close", new Blob([body], { type: "application/json" }));
    if (!delivered) postSession("/api/workbench-session/close", sessionId);
  };

  heartbeat();
  window.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  window.addEventListener("pagehide", close);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    pageHidden = false;
    heartbeat();
  });
}
