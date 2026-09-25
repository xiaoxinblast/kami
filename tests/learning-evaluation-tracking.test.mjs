import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

test("正在跑的评测是页面状态，不是按钮上的临时文字", () => {
  // 事故：评测在服务端一直跑，但前端只把"评测中"写进按钮文字，
  // 任何一次重绘（切视图、换范围、点卡片）都会让按钮退回"运行评测"。
  assert.match(app, /learningEvaluationJobs: \[\]/u);
  assert.match(app, /const LEARNING_EVALUATION_ACTIVE_STATUSES = new Set\(\["queued", "running", "interrupted"\]\);/u);
  assert.match(app, /function activeEvaluationJobFor\(skillId\)/u);
  assert.match(app, /function evaluationProgressText\(job\)/u);
  assert.match(app, /评测中 \$\{completed\}\/\$\{requested\}/u);
  // 卡片按钮把"能不能点"和"有没有评测"固化成属性，轮询只改文字，不整页重绘。
  assert.match(app, /data-baseline-current="\$\{baselineCurrent \? "1" : "0"\}" data-has-evaluation="\$\{evaluation \? "1" : "0"\}"/u);
  assert.match(app, /function syncLearningEvaluationProgress\(\)/u);
  assert.match(app, /button\.dataset\.hasEvaluation === "1" \? "重新评测" : "运行评测"/u);
  // 进页面就带任务清单：后台还在跑时不用再点一次才知道。
  assert.match(app, /async function loadLearningEvaluationJobs\(\)/u);
  assert.match(app, /api\(`\/api\/learning\/evaluation-jobs\$\{params\.size \? `\?\$\{params\}` : ""\}`\)/u);
  assert.match(app, /\[state\.learningData\] = await Promise\.all\(\[/u);
  // 轮询：网络抖动只跳过这一轮，不再把"评测中"退回"运行评测"；结束后自动刷新结论。
  assert.match(app, /catch \{ continue; \}/u);
  assert.match(app, /const LEARNING_EVALUATION_POLL_MS = 4000;/u);
  assert.match(app, /候选评测完成并通过晋升门槛，可批准启用/u);
  assert.doesNotMatch(app, /async function watchEvaluationJob/u, "旧的按钮文字轮询已经删掉");
});

test("通知中心：铃铛、未读角标与面板都在页面里", () => {
  assert.match(html, /id="notificationBell"/u);
  assert.match(html, /id="notificationBadge"/u);
  assert.match(html, /id="notificationList"/u);
  assert.match(styles, /\.notification-bell/u);
  assert.match(styles, /\.notification-badge/u);
  // 已读要退到背景里：浅色文字 + 灰点（彩色圆点只留给未读）。
  assert.match(app, /const isUnread = highlight \? highlight\.has\(item\.id\) : Boolean\(item\.at\) && item\.at > seenAt;/u);
  assert.match(app, /isUnread \? "is-unread" : "is-read"/u);
  // 打开面板时冻结"本次新到"的那几条：角标立刻清零，高亮留到关掉面板为止。
  assert.match(app, /state\.notificationHighlight = new Set\(unreadNotifications\(\)\.map\(\(item\) => item\.id\)\);/u);
  assert.match(styles, /\.notification-item\.is-read \.notification-dot \{ background: #dfe4dc; \}/u);
  assert.match(styles, /\.notification-item\.is-read strong \{ color: #7c8981;/u);
});
