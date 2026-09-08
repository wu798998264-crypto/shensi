import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(app, /syncSettingsSectionVisibility\(\);[\s\S]{0,420}requestedSection === "skill"[\s\S]{0,220}renderSkillSettings\(\);[\s\S]{0,120}refreshSkillCatalog\(\)/u,
  "Skill 设置第一次点击必须同步绘制加载或缓存内容，不能等待切换标签后才显示");
assert.match(css, /\.media-recovery-dialog \{[^}]*overflow: hidden/u,
  "待处理弹窗外层必须禁止滚动");
assert.match(css, /\.media-recovery-dialog form \{[^}]*overflow: hidden/u,
  "待处理弹窗表单必须禁止产生第二根滚动条");
assert.match(css, /\.media-recovery-list \{[^}]*overflow-y: auto/u,
  "待处理任务列表必须是唯一纵向滚动容器");

console.log("Skill first paint and recovery single-scroll regressions passed");
