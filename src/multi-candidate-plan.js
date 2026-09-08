export const MULTI_CANDIDATE_MIN = 2;
export const MULTI_CANDIDATE_MAX = 4;

const DIRECTION_LABELS = Object.freeze({
  free: "自由发挥",
  pacing: "节奏差异",
  emotion: "情绪差异",
  perspective: "叙事视角差异",
});

export const normalizeMultiCandidateCount = (value, fallback = MULTI_CANDIDATE_MIN) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= MULTI_CANDIDATE_MIN && number <= MULTI_CANDIDATE_MAX
    ? number
    : fallback;
};

export const multiCandidateGenerationInstruction = ({ prompt = "", count, direction = "free", note = "", writerIds = [], countsByWriter = {} } = {}) => {
  const source = String(prompt || "").trim();
  if (!source) return "";
  const candidateCount = normalizeMultiCandidateCount(count);
  const directionLabel = DIRECTION_LABELS[direction] || DIRECTION_LABELS.free;
  const customNote = String(note || "").trim().slice(0, 1200);
  const writerList = Array.isArray(writerIds) ? writerIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  const writerInstruction = writerList.length
    ? `参与主笔：${writerList.map((id) => `${id}${countsByWriter?.[id] ? `（${countsByWriter[id]} 份）` : ""}`).join("、")}。必须分别标记每份候选的主笔来源。`
    : "本轮使用当前主笔生成候选稿。";
  const totalCount = writerList.length
    ? writerList.reduce((sum, id) => sum + (Number(countsByWriter?.[id]) || 0), 0)
    : candidateCount;
  return [
    source,
    "【多候选生成配置】",
    `请在同一目标、同一文档 revision 和同一上下文快照下，独立生成 ${totalCount} 份候选版本。`,
    writerInstruction,
    `候选差异方向：${directionLabel}。每份候选必须完整、独立，不能把多稿拼成同一篇。`,
    "本轮只生成 candidate_only 候选，不得自动落盘；用户会在现有候选查看窗口中逐份查看并点击“选用”后再进入安全写入事务。",
    "本轮选项只是用户输入的便捷表达，不是不可更改的持久设置；后续用户用自然语言改变数量、主笔或方向时，以最新表达为准，不得要求用户返回已经隐藏的选项面板修改。",
    customNote ? `作者补充要求：${customNote}` : "",
  ].filter(Boolean).join("\n");
};
