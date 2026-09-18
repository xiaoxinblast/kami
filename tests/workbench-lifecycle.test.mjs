import test from "node:test";
import assert from "node:assert/strict";
import { WorkbenchSessionMonitor, shutdownDockerDesktop } from "../src/workbench-lifecycle.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("最后一个页面关闭后经过宽限期才停止，刷新会取消本次停止", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ closeGraceMs: 50, heartbeatGraceMs: 50, onIdle: async () => { shutdowns += 1; } });
  monitor.start();
  monitor.touch("tab-a");
  monitor.close("tab-a");
  await wait(20);
  monitor.touch("tab-b"); // 刷新后的新页面在宽限期内重新报到。
  await wait(40);
  assert.equal(shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);

  monitor.close("tab-b");
  await wait(70);
  assert.equal(shutdowns, 1);
  monitor.dispose();
});

test("关闭其中一个标签页不会影响仍在心跳的标签页", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ closeGraceMs: 50, heartbeatGraceMs: 50, onIdle: async () => { shutdowns += 1; } });
  monitor.start();
  monitor.touch("tab-a");
  monitor.touch("tab-b");
  monitor.close("tab-a");
  await wait(30);
  monitor.touch("tab-b");
  await wait(30);
  assert.equal(shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);

  monitor.close("tab-b");
  await wait(70);
  assert.equal(shutdowns, 1);
  monitor.dispose();
});

test("挂机导致心跳变慢不会当成关页面", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ closeGraceMs: 20, heartbeatGraceMs: 5 * 60_000, onIdle: async () => { shutdowns += 1; } });
  monitor.start();
  monitor.touch("tab-minimized");
  // 后台标签被节流后心跳从 5 秒退化到 1 分钟一次；这里远超关闭宽限期也不该收尾。
  await wait(300);
  assert.equal(shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);
  monitor.dispose();
});

test("心跳失联超过心跳宽限期才按关闭处理", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ closeGraceMs: 20, heartbeatGraceMs: 60, onIdle: async () => { shutdowns += 1; } });
  monitor.start();
  monitor.touch("tab-gone");
  await wait(120);
  assert.equal(shutdowns, 1);
  monitor.dispose();
});

test("启动后还没出现过页面时，不会在关闭宽限期内就把工作台关掉", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ closeGraceMs: 20, heartbeatGraceMs: 200, startupGraceMs: 120, onIdle: async () => { shutdowns += 1; } });
  monitor.start();
  // 浏览器冷启动：页面还没报到，此时不该按"最后一个页面关闭"处理。
  await wait(60);
  assert.equal(shutdowns, 0);
  monitor.touch("tab-late");
  await wait(60);
  assert.equal(shutdowns, 0);
  assert.equal(monitor.activeSessionCount, 1);
  monitor.dispose();
});

test("一直没有页面报到时，超过启动宽限才收尾", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ closeGraceMs: 20, heartbeatGraceMs: 200, startupGraceMs: 60, onIdle: async () => { shutdowns += 1; } });
  monitor.start();
  await wait(140);
  assert.equal(shutdowns, 1);
  monitor.dispose();
});

test("后台任务执行期间不自动收尾，任务结束后才收尾", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ closeGraceMs: 20, heartbeatGraceMs: 40, onIdle: async () => { shutdowns += 1; } });
  monitor.start();
  monitor.hold("task:import-1");
  monitor.touch("tab-a");
  monitor.close("tab-a");
  await wait(100);
  assert.equal(shutdowns, 0);
  assert.equal(monitor.activeHoldCount, 1);

  monitor.release("task:import-1");
  await wait(100);
  assert.equal(shutdowns, 1);
  monitor.dispose();
});

test("任务执行期间重新打开页面会取消原本的收尾", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ closeGraceMs: 20, heartbeatGraceMs: 200, onIdle: async () => { shutdowns += 1; } });
  monitor.start();
  monitor.touch("tab-a");
  monitor.hold("task:import-1");
  monitor.close("tab-a");
  await wait(50);
  monitor.touch("tab-b");
  monitor.release("task:import-1");
  await wait(50);
  assert.equal(shutdowns, 0);
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
