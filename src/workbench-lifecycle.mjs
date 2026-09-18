import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 跟踪已打开的工作台页面。
 *
 * 收尾判定分两种，因为"页面消失"有两种完全不同的成因：
 *   1. 显式关闭（pagehide 时发 sendBeacon）：只留很短的宽限期，够普通刷新
 *      重新报到即可，用户关掉最后一个页面就该停。
 *   2. 心跳失联：页面被最小化挂机、切到后台标签后被 Chromium 节流甚至冻结，
 *      定时器从 5 秒退化到每分钟一次甚至完全停摆——这**不是**关闭。
 *      只有失联超过 heartbeatGraceMs（默认 30 分钟）才按关闭处理。
 *
 * 另外提供 hold/release：后台任务执行期间不允许自动收尾，
 * 否则一个正在写库的导入会被"关页面"规则连带杀掉。
 */
export class WorkbenchSessionMonitor {
  constructor({
    closeGraceMs = 15_000,
    heartbeatGraceMs = 30 * 60_000,
    startupGraceMs = 5 * 60_000,
    onIdle = async () => {},
    onError = console.error,
    now = () => Date.now(),
    schedule = setTimeout,
    cancel = clearTimeout
  } = {}) {
    if (!Number.isFinite(closeGraceMs) || closeGraceMs < 1) throw new Error("页面关闭宽限期必须是正数");
    if (!Number.isFinite(heartbeatGraceMs) || heartbeatGraceMs < 1) throw new Error("页面心跳宽限期必须是正数");
    this.closeGraceMs = closeGraceMs;
    this.heartbeatGraceMs = heartbeatGraceMs;
    this.startupGraceMs = startupGraceMs;
    this.onIdle = onIdle;
    this.onError = onError;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.sessions = new Map();
    this.holds = new Set();
    this.closeDeadline = null;
    this.everHadSession = false;
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
    this.everHadSession = true;
    // 新页面在关闭宽限期内报到（刷新、恢复标签页），取消这次收尾。
    this.closeDeadline = null;
    this.#reschedule();
    return true;
  }

  close(id) {
    if (this.shuttingDown) return false;
    this.sessions.delete(id);
    this.closeDeadline = this.sessions.size ? null : this.now() + this.closeGraceMs;
    this.#reschedule();
    return true;
  }

  /** 长期任务（后台导入、清洗、导出）执行期间挂住收尾判定。 */
  hold(id) {
    if (this.shuttingDown) return false;
    this.holds.add(String(id));
    this.#reschedule();
    return true;
  }

  release(id) {
    if (this.shuttingDown) return false;
    const released = this.holds.delete(String(id));
    this.#reschedule();
    return released;
  }

  dispose() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.sessions.clear();
    this.holds.clear();
    this.closeDeadline = null;
  }

  get activeSessionCount() {
    this.#prune(this.now());
    return this.sessions.size;
  }

  get activeHoldCount() {
    return this.holds.size;
  }

  #prune(now) {
    for (const [id, lastSeenAt] of this.sessions) {
      if (now - lastSeenAt >= this.heartbeatGraceMs) this.sessions.delete(id);
    }
  }

  /** 下一次需要醒来判定的时刻；返回 null 表示当前不需要定时器（有 hold 或已停）。 */
  #nextWakeAt(now) {
    if (this.holds.size) return null;
    if (this.sessions.size) return Math.min(...this.sessions.values()) + this.heartbeatGraceMs;
    if (this.closeDeadline !== null) return this.closeDeadline;
    // 还没出现过任何页面：给浏览器冷启动留时间，别在启动十几秒后就把工作台关掉。
    return now + (this.everHadSession ? this.closeGraceMs : this.startupGraceMs);
  }

  #reschedule() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (this.shuttingDown) return;

    const now = this.now();
    this.#prune(now);
    const nextCheckAt = this.#nextWakeAt(now);
    if (nextCheckAt === null) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.#checkIdle().catch((error) => this.onError(error));
    }, Math.max(0, nextCheckAt - now));
    this.timer.unref?.();
  }

  async #checkIdle() {
    if (this.shuttingDown) return;
    const now = this.now();
    this.#prune(now);
    if (this.holds.size) {
      this.#reschedule();
      return;
    }
    if (this.sessions.size) {
      this.#reschedule();
      return;
    }
    // 显式关闭后还没到宽限期：等刷新或恢复标签页。
    if (this.closeDeadline !== null && now < this.closeDeadline) {
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
