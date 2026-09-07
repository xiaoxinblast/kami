import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 跟踪已打开的工作台页面。最后一个页面消失后留出宽限期，
 * 让普通刷新或浏览器的页面缓存恢复不会被误判为退出。
 */
export class WorkbenchSessionMonitor {
  constructor({ idleMs = 15_000, onIdle = async () => {}, onError = console.error, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
    if (!Number.isFinite(idleMs) || idleMs < 1) throw new Error("页面空闲宽限期必须是正数");
    this.idleMs = idleMs;
    this.onIdle = onIdle;
    this.onError = onError;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.sessions = new Map();
    this.timer = null;
    this.shuttingDown = false;
  }

  start() {
    if (this.shuttingDown) return;
    this.#reschedule();
  }

  touch(id) {
    if (this.shuttingDown) return false;
    this.sessions.set(id, this.now());
    this.#reschedule();
    return true;
  }

  close(id) {
    if (this.shuttingDown) return false;
    this.sessions.delete(id);
    this.#reschedule();
    return true;
  }

  dispose() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.sessions.clear();
  }

  get activeSessionCount() {
    this.#prune(this.now());
    return this.sessions.size;
  }

  #prune(now) {
    for (const [id, lastSeenAt] of this.sessions) {
      if (now - lastSeenAt >= this.idleMs) this.sessions.delete(id);
    }
  }

  #reschedule() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (this.shuttingDown) return;

    const now = this.now();
    this.#prune(now);
    const nextCheckAt = this.sessions.size
      ? Math.min(...this.sessions.values()) + this.idleMs
      : now + this.idleMs;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.#checkIdle().catch((error) => this.onError(error));
    }, Math.max(0, nextCheckAt - now));
    this.timer.unref?.();
  }

  async #checkIdle() {
    if (this.shuttingDown) return;
    this.#prune(this.now());
    if (this.sessions.size) {
      this.#reschedule();
      return;
    }
    this.shuttingDown = true;
    await this.onIdle();
  }
}

async function runDocker(args, { cwd }) {
  return execFileAsync("docker", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
    windowsHide: true
  });
}

/**
 * 仅停止 Kami 自己的 Compose 项目；确认没有任何其它运行中容器后，
 * 才调用 Docker Desktop 自带的 CLI 退出整个 Desktop。
 */
export async function shutdownDockerDesktop({ cwd, run = runDocker, logger = console } = {}) {
  if (!cwd) throw new Error("缺少 Kami 工作台目录，无法停止 Docker 服务");
  await run(["compose", "--env-file", "directus/.env", "-f", "directus/docker-compose.yml", "down"], { cwd });

  const { stdout = "" } = await run(["ps", "--format", "{{.Names}}"], { cwd });
  const otherContainers = String(stdout).split(/\r?\n/u).map((name) => name.trim()).filter(Boolean);
  if (otherContainers.length) {
    logger.warn?.(`[Kami] 已停止 Kami 容器；仍有其它运行中的容器，因此不会退出 Docker Desktop：${otherContainers.join(", ")}`);
    return { desktopStopped: false, otherContainers };
  }

  await run(["desktop", "stop", "--detach"], { cwd });
  logger.info?.("[Kami] Docker Desktop 正在退出。");
  return { desktopStopped: true, otherContainers: [] };
}
