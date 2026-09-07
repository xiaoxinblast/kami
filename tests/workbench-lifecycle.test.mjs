import test from "node:test";
import assert from "node:assert/strict";
import { WorkbenchSessionMonitor, shutdownDockerDesktop } from "../src/workbench-lifecycle.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("最后一个页面关闭后经过宽限期才停止，刷新会取消本次停止", async () => {
  let shutdowns = 0;
  const monitor = new WorkbenchSessionMonitor({ idleMs: 50, onIdle: async () => { shutdowns += 1; } });
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
  const monitor = new WorkbenchSessionMonitor({ idleMs: 50, onIdle: async () => { shutdowns += 1; } });
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
