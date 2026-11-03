import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const deploy = readFileSync("docs/deploy.md", "utf8");
const surface = readFileSync("docs/message-surface.md", "utf8");

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

console.log("readme ok");
