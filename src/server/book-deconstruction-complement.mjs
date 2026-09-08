import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const ANALYZER_SOURCES = Object.freeze({
  long: "小说写作技能skill/01-oh-story-claudecode/原始资料/story-long-analyze/SKILL.md",
  short: "小说写作技能skill/01-oh-story-claudecode/原始资料/story-short-analyze/SKILL.md",
});

const ANALYZER_LABELS = Object.freeze({
  long: "01-oh-story-claudecode / story-long-analyze",
  short: "01-oh-story-claudecode / story-short-analyze",
});

const isInside = (candidate, parent) => {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const selectOhStoryAnalyzer = ({ totalChars = 0, requestText = "" } = {}) => {
  const text = String(requestText ?? "");
  if (/短篇|盐言|故事会|一万字|短文/.test(text) && !/长篇|全书|整本|黄金三章/.test(text)) return "short";
  if (/长篇|全书|整本|连载|黄金三章|逐章/.test(text)) return "long";
  const chars = Number(totalChars) || 0;
  if (chars > 20_000) return "long";
  if (chars < 15_000) return "short";
  const chapterMarkers = text.match(/(?:^|\n)\s*第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回]/g) || [];
  return chapterMarkers.length >= 4 || /(?:第一|第[零〇一二三四五六七八九十百千万两\d]+)卷|卷一|卷二/.test(text) ? "long" : "short";
};

const integrationContract = ({ analyzer }) => `
# 双 Skill 爆款拆书互补合同

主控 Skill 负责覆盖审计与证据边界：只分析实际可读内容，区分全书拆解与样本拆解，维护逐单元证据账本，最终统一输出可迁移机制与改编依据。

本轮同时启用 ${ANALYZER_LABELS[analyzer]} 作为专项拆解器：

- 长篇专项补充黄金三章、逐章摘要、剧情聚合、读者需求、情绪引擎、节奏、角色关系、设定与文风画像。
- 短篇专项补充故事核、功能分段、情感曲线、爆点、反转铺垫、写作手法、共鸣层次与结构计数。
- 两套 Skill 只生成一份合并报告，不各自输出重复结论；同一结论冲突时，以原文可定位证据和主控 Skill 的覆盖边界为准。
- 下方原始 Skill 中的 slash command、Agent、外部浏览器、安装更新、项目初始化、源文件复制和固定目录写入均属于原宿主运行说明，在神思软件中不执行。神思只吸收其文学分析方法；读取、分块、任务恢复与落盘继续由本地可信编排器负责。
- 原始 Skill 提到“原文/ 抄语感”等表达时，只允许提炼抽象表达策略，不得模仿受版权保护作者的独特文风，也不得大段复制原文。
`.trim();

export const loadOhStoryDeconstructionComplement = async ({
  shensiRoot,
  totalChars = 0,
  requestText = "",
} = {}) => {
  const root = resolve(String(shensiRoot ?? ""));
  const analyzer = selectOhStoryAnalyzer({ totalChars, requestText });
  const relativeSource = ANALYZER_SOURCES[analyzer];
  const sourcePath = resolve(root, relativeSource);
  if (!isInside(sourcePath, root)) throw new Error("01-oh-story-claudecode 拆书规则路径越界");
  try {
    const metadata = await stat(sourcePath);
    if (!metadata.isFile()) throw new Error("not-file");
  } catch {
    throw new Error(`神思缺少爆款拆书互补规则：${ANALYZER_LABELS[analyzer]}`);
  }
  const content = await readFile(sourcePath, "utf8");
  if (!content.trim()) throw new Error(`爆款拆书互补规则为空：${ANALYZER_LABELS[analyzer]}`);
  return {
    analyzer,
    label: ANALYZER_LABELS[analyzer],
    relativeSource,
    promptText: `${integrationContract({ analyzer })}\n\n# 互补专项原始方法\n\n${content}`,
  };
};
