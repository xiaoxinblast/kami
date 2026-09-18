import test from "node:test";
import assert from "node:assert/strict";
import { WorkbenchSessionMonitor, shutdownDockerDesktop } from "../src/workbench-lifecycle.mjs";

/**
 * 收尾判定全部按时间走，用真实定时器（50ms 宽限 + 30ms sleep）在机器繁忙时会抖：
 * 并行跑全量测试时曾三次运行失败在三个不同用例上。monitor 支持注入 now/schedule/cancel，
 * 这里换成受控时钟，时间推进与定时器触发完全确定。
 */
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const flushMicrotasks = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  return {
    now: () => now,
    schedule(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    cancel(id) { timers.delete(id); },
    pending: () => timers.size,
    /** 推进到 now + milliseconds，按到期顺序执行定时器（回调里新排的定时器照常处理）。 */
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (let guard = 0; guard < 1_000; guard += 1) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.callback();
        await flushMicrotasks();
      }
      now = target;
      await flushMicrotasks();
    }
  };
}

function createMonitor(clock, { closeGraceMs = 50, heartbeatGraceMs = 50, startupGraceMs = 10_000 } = {}) {
  const state = { shutdowns: 0 };
  const monitor = new WorkbenchSessionMonitor({
    closeGraceMs,
    heartbeatGraceMs,
    startupGraceMs,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onIdle: async () => { state.shutdowns += 1; }
  });
  return { monitor, state };
}

test("最后一个页面关闭后经过宽限期才停止，刷新会取消本次停止", async () => {
  const clock = createClock();
  const { monitor, state } = createMonitor(clock, { closeGraceMs: 50, heartbeatGraceMs: 50 });
  monitor.start();
  monitor.touch("tab-a");
  monitor.close("tab-a");
  await clock.advance(20);
  monitor.touch("tab-b"); // 刷新后的新页面在宽限期内重新报到。
  await clock.advance(40);
  assert.equal(state.shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);

  monitor.close("tab-b");
  await clock.advance(49);
  assert.equal(state.shutdowns, 0, "宽限期内还不能停");
  await clock.advance(1);
  assert.equal(state.shutdowns, 1);
  monitor.dispose();
});

test("关闭其中一个标签页不会影响仍在心跳的标签页", async () => {
  const clock = createClock();
  const { monitor, state } = createMonitor(clock, { closeGraceMs: 50, heartbeatGraceMs: 50 });
  monitor.start();
  monitor.touch("tab-a");
  monitor.touch("tab-b");
  monitor.close("tab-a");
  await clock.advance(30);
  monitor.touch("tab-b");
  await clock.advance(30);
  assert.equal(state.shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);

  monitor.close("tab-b");
  await clock.advance(50);
  assert.equal(state.shutdowns, 1);
  monitor.dispose();
});

test("挂机导致心跳变慢不会当成关页面", async () => {
  const clock = createClock();
  const { monitor, state } = createMonitor(clock, { closeGraceMs: 20, heartbeatGraceMs: 5 * 60_000 });
  monitor.start();
  monitor.touch("tab-minimized");
  // 后台标签被节流后心跳从 5 秒退化到 1 分钟一次；这里远超关闭宽限期也不该收尾。
  await clock.advance(4 * 60_000);
  assert.equal(state.shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);
  monitor.dispose();
});

test("心跳失联超过心跳宽限期才按关闭处理", async () => {
  const clock = createClock();
  const { monitor, state } = createMonitor(clock, { closeGraceMs: 20, heartbeatGraceMs: 60 });
  monitor.start();
  monitor.touch("tab-gone");
  await clock.advance(59);
  assert.equal(state.shutdowns, 0, "未到心跳宽限期不能判成关闭");
  await clock.advance(1);
  assert.equal(state.shutdowns, 1);
  monitor.dispose();
});

test("启动后还没出现过页面时，不会在关闭宽限期内就把工作台关掉", async () => {
  const clock = createClock();
  const { monitor, state } = createMonitor(clock, { closeGraceMs: 20, heartbeatGraceMs: 200, startupGraceMs: 120 });
  monitor.start();
  // 浏览器冷启动：页面还没报到，此时不该按"最后一个页面关闭"处理。
  await clock.advance(60);
  assert.equal(state.shutdowns, 0);
  monitor.touch("tab-late");
  await clock.advance(60);
  assert.equal(state.shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);
  monitor.dispose();
});

test("一直没有页面报到时，超过启动宽限才收尾", async () => {
  const clock = createClock();
  const { monitor, state } = createMonitor(clock, { closeGraceMs: 20, heartbeatGraceMs: 200, startupGraceMs: 60 });
  monitor.start();
  await clock.advance(59);
  assert.equal(state.shutdowns, 0);
  await clock.advance(1);
  assert.equal(state.shutdowns, 1);
  monitor.dispose();
});

test("后台任务执行期间不自动收尾，任务结束后才收尾", async () => {
  const clock = createClock();
  const { monitor, state } = createMonitor(clock, { closeGraceMs: 20, heartbeatGraceMs: 40 });
  monitor.start();
  monitor.hold("task:import-1");
  monitor.touch("tab-a");
  monitor.close("tab-a");
  assert.equal(clock.pending(), 0, "有 hold 时不该排收尾定时器");
  await clock.advance(100);
  assert.equal(state.shutdowns, 0);
  assert.equal(monitor.activeHoldCount, 1);

  monitor.release("task:import-1");
  await clock.advance(1);
  assert.equal(state.shutdowns, 1);
  monitor.dispose();
});

test("任务执行期间重新打开页面会取消原本的收尾", async () => {
  const clock = createClock();
  const { monitor, state } = createMonitor(clock, { closeGraceMs: 20, heartbeatGraceMs: 200 });
  monitor.start();
  monitor.touch("tab-a");
  monitor.hold("task:import-1");
  monitor.close("tab-a");
  await clock.advance(50);
  monitor.touch("tab-b");
  monitor.release("task:import-1");
  await clock.advance(50);
  assert.equal(state.shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);
  monitor.dispose();
});

test("Kami 容器停止后无其它容器时才退出 Docker Desktop", async () => {
  const calls = [];
  const messages = [];
  const result = await shutdownDockerDesktop({
    cwd: "C:\\Kami",
    run: async (args) => {
      calls.push(args);
      return args[0] === "ps" ? { stdout: "" } : { stdout: "", stderr: "" };
    },
    logger: { info: (message) => messages.push(message), warn: (message) => messages.push(message) }
  });

  assert.deepEqual(calls, [
    ["compose", "--env-file", "directus/.env", "-f", "directus/docker-compose.yml", "down"],
    ["ps", "--format", "{{.Names}}"],
    ["desktop", "stop", "--detach"]
  ]);
  assert.deepEqual(result, { desktopStopped: true, otherContainers: [] });
  assert.match(messages[0], /Docker Desktop 正在退出/);
});

test("检测到其它容器时保留 Docker Desktop", async () => {
  const calls = [];
  const messages = [];
  const result = await shutdownDockerDesktop({
    cwd: "C:\\Kami",
    run: async (args) => {
      calls.push(args);
      return args[0] === "ps" ? { stdout: "another-project\n" } : { stdout: "", stderr: "" };
    },
    logger: { info: (message) => messages.push(message), warn: (message) => messages.push(message) }
  });

  assert.deepEqual(calls, [
    ["compose", "--env-file", "directus/.env", "-f", "directus/docker-compose.yml", "down"],
    ["ps", "--format", "{{.Names}}"]
  ]);
  assert.deepEqual(result, { desktopStopped: false, otherContainers: ["another-project"] });
  assert.match(messages[0], /another-project/);
});
