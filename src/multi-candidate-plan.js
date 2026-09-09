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

export const multiCandidateGenerationInstruction = ({ prompt = "", count, direction = "free", note = "" } = {}) => {
  const source = String(prompt || "").trim();
  if (!source) return "";
  const candidateCount = normalizeMultiCandidateCount(count);
  const directionLabel = DIRECTION_LABELS[direction] || DIRECTION_LABELS.free;
  const customNote = String(note || "").trim().slice(0, 1200);
  return [
    source,
    "【多候选生成配置】",
    `请在同一目标、同一文档 revision 和同一上下文快照下，独立生成 ${candidateCount} 份候选版本。`,
    `候选差异方向：${directionLabel}。每份候选必须完整、独立，不能把多稿拼成同一篇。`,
    "本轮只生成 candidate_only 候选，不得自动落盘；用户会在现有候选查看窗口中逐份查看并点击“选用”后再进入安全写入事务。",
    "候选数量和差异直接来自用户的自然语言描述；不得询问由谁主笔或几个主笔。",
    customNote ? `作者补充要求：${customNote}` : "",
  ].filter(Boolean).join("\n");
};
