import { normalizeSmartLandingPlan, splitLandingBlocks } from "../smart-landing.js";
import { parseStructuredModelOutput } from "./shensi-orchestrator.mjs";

const LANDING_SYSTEM = `你是本地创作软件的落盘规划器。你只负责把已生成的回答分配到正确文档，不改写内容，不声称已经写入文件。

只返回JSON：
{
  "summary": "识别结果",
  "documents": [
    {"documentId":"现有文档ID，与targetHint二选一","targetHint":"标准目标描述","title":"可选","blocks":[1,2]}
  ]
}

规则：
1. blocks是回答分块编号，每个编号最多分配一次；只分配真正应保存的作品内容，简短说明和操作提示可不分配。
2. 优先使用清单中已有文档的documentId；只有没有对应文档时才使用targetHint。
3. targetHint必须是可明确归类的标准资产，例如：全集大纲、第2卷卷纲、第8章章纲、第8章正文、人物设定、世界观设定、地点设定、势力设定、时间线、状态快照、信息释放表、剧本全集大纲、第3集集纲、第3集剧本、剧本设定、剧本状态快照、视频提示词、视觉资产提示词、全景调度图提示词、小说自检报告、改编报告、《作品名》爆款拆书报告、参考资料。章节记忆、分集记忆和上下文包不是可落盘目标。
4. 不得创造清单中不存在的documentId，不得把设定、大纲或剧本因为当前打开正文就误写到正文。
5. 如果提供了“本轮强制目标”，documents必须与该清单一一对应，不得遗漏、增加或替换目标；已有目标使用documentId，尚未建立的目标使用对应title作为targetHint。
6. 如果内容无法确定归属，documents返回空数组。不要输出Markdown或解释。`;

const safeText = (value, max) => String(value ?? "").slice(0, max);

export const planSmartLanding = async ({ settings = {}, sourcePrompt = "", answer = "", inventory = [], requiredTargets = [], contextDomain = "novel", cwd, runModel, signal }) => {
  const blocks = splitLandingBlocks(safeText(answer, 120_000));
  if (!blocks.length) return { plan: null, protocol: "", providerResponseId: "" };
  const safeInventory = (Array.isArray(inventory) ? inventory : []).slice(0, 1200).map((item) => ({
    id: safeText(item?.id, 180),
    title: safeText(item?.title, 180),
    moduleId: safeText(item?.moduleId, 40),
    viewId: safeText(item?.viewId, 40),
    folderLabel: safeText(item?.folderLabel, 180),
  })).filter((item) => item.id && item.title);
  const safeRequiredTargets = (Array.isArray(requiredTargets) ? requiredTargets : []).slice(0, 100).map((target) => ({
    documentId: safeText(target?.documentId, 180),
    title: safeText(target?.title, 180),
    moduleId: safeText(target?.moduleId, 40),
  })).filter((target) => target.documentId && target.title);
  const numberedBlocks = blocks.map((content, index) => `[${index + 1}] ${safeText(content, 8000)}`).join("\n\n");
  const result = await runModel({
    settings: {
      ...settings,
      temperature: "0.1",
      maxOutputTokens: String(Math.min(Number(settings.maxOutputTokens) || 3000, 4000)),
    },
    messages: [{ role: "user", content: [
      `原始生成指令：\n${safeText(sourcePrompt, 6000)}`,
      `当前内容领域：${safeText(contextDomain, 40)}`,
      `已有文档清单：\n${JSON.stringify(safeInventory)}`,
      safeRequiredTargets.length ? `本轮强制目标（必须且只能各返回一次）：\n${JSON.stringify(safeRequiredTargets)}` : "",
      `待分配回答：\n${numberedBlocks}`,
    ].filter(Boolean).join("\n\n") }],
    system: LANDING_SYSTEM,
    cwd,
    attachments: [],
    signal,
  });
  const plan = normalizeSmartLandingPlan(parseStructuredModelOutput(result.text), {
    documentIds: safeInventory.map((item) => item.id),
    blockCount: blocks.length,
  });
  return { plan, protocol: result.protocol, providerResponseId: result.providerResponseId };
};
