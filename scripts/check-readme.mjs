import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const deploy = readFileSync("docs/deploy.md", "utf8");
const surface = readFileSync("docs/message-surface.md", "utf8");
const webhook = readFileSync("examples/telegram-webhook/README.md", "utf8");
const architecture = readFileSync("docs/architecture.md", "utf8");
const plugins = readFileSync("docs/plugins.md", "utf8");

function longestLine(text) {
  return text.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const start = readme.indexOf("## 30 秒");
const end = readme.indexOf("## 10 分钟跑通");
if (start < 0 || end < start) {
  fail("README 缺少「30 秒」或「10 分钟跑通」");
}
const section = readme.slice(start, end);
if (section.length > 1600) {
  fail(`README「30 秒」一节有 ${section.length} 个字符，超过 1600`);
}
if (section.includes("ADR ")) {
  fail("README「30 秒」一节不应再堆 ADR 编号");
}
if (deploy.includes("还不会调用删除")) {
  fail("docs/deploy.md 的确认步骤仍写着不会调用删除接口");
}
if (!deploy.includes("RATE_WINDOW")) {
  fail("docs/deploy.md 缺少 RATE_WINDOW 的部署说明");
}
if (!surface.includes("ADR 0325") || !surface.includes("ADR 0022")) {
  fail("docs/message-surface.md 缺了已经记录的字段行为");
}
for (const line of readme.split("\n")) {
  if (
    (line.startsWith("packages/platform-telegram") ||
      line.startsWith("packages/detectors-link")) &&
    line.length > 160
  ) {
    fail(`仓库地图这一行又变长了：${line.slice(0, 40)}…`);
  }
}
if (webhook.includes("处罚仍然不请求")) {
  fail("webhook 示例仍写着处罚不请求 Telegram");
}
if (
  !webhook.includes("TELEGRAM_BOT_TOKEN") ||
  !webhook.includes("message-surface.md")
) {
  fail("webhook 示例缺少 token 说明或字段清单链接");
}
if (longestLine(webhook) > 800) {
  fail(`webhook 示例有一行 ${longestLine(webhook)} 个字符，字段清单又堆回来了`);
}
if (
  !architecture.includes("message-surface.md") ||
  !architecture.includes("deleteMessage")
) {
  fail("架构说明缺少字段清单链接或删除接口");
}
if (
  !architecture.includes("RATE_WINDOW") ||
  !architecture.includes("30 天自动清理还没有做")
) {
  fail("架构说明少了窗口或保留期限");
}
if (longestLine(architecture) > 4000) {
  fail(
    `架构说明有一行 ${longestLine(architecture)} 个字符，字段清单又堆回来了`,
  );
}
if (
  !plugins.includes("message-surface.md") ||
  !plugins.includes("ReputationSource")
) {
  fail("插件说明缺少字段清单链接或信誉源");
}
if (longestLine(plugins) > 800) {
  fail(`插件说明有一行 ${longestLine(plugins)} 个字符，字段清单又堆回来了`);
}

console.log("readme ok");
