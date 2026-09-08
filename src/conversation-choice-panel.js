const WRITER_MODES = new Set(["single", "multiple"]);
const STEPS = new Set(["writer_mode", "direction", "candidate_count", "writers", "writer_counts", "confirm"]);
const DIRECTIONS = new Set(["free", "pacing", "emotion", "perspective"]);
const COUNTS = new Set(Array.from({ length: 20 }, (_, index) => index + 1));
const CHINESE_COUNT_DIGITS = Object.freeze({
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
});

const candidateCountValue = (value = "") => {
  const token = String(value || "").trim();
  if (/^\d{1,2}$/u.test(token)) return Math.max(1, Math.min(20, Number(token)));
  if (Object.hasOwn(CHINESE_COUNT_DIGITS, token)) return CHINESE_COUNT_DIGITS[token];
  const compound = token.match(/^十([一二三四五六七八九])$/u);
  if (compound) return 10 + CHINESE_COUNT_DIGITS[compound[1]];
  return 0;
};

export const conversationChoiceOverrideFromInstruction = (instruction = "") => {
  const text = String(instruction || "").trim();
  if (!text) return null;
  const override = {};
  if (/(?:改为|改成|换成|选择|使用|还是|不用[^，。；]*[，,]?\s*)?多主笔/u.test(text)) override.writerMode = "multiple";
  else if (/(?:改为|改成|换成|选择|使用|还是)?单主笔/u.test(text)) override.writerMode = "single";
  const changed = text.match(/(?:改为|改成|调整为|换成|变成)\s*([一二两三四五六七八九十\d]{1,3})(?:\s*(?:份|个|稿))?/u);
  const candidate = changed || text.match(/([一二两三四五六七八九十\d]{1,3})\s*份(?:候选稿?|稿件)?/u);
  const candidateCount = candidateCountValue(candidate?.[1]);
  if (candidateCount) override.candidateCount = candidateCount;
  if (/续写下一章|开始下一章|下一章继续/u.test(text)) override.continuationDestination = "next";
  else if (/续写当前(?:文档|章节|章)|继续当前(?:文档|章节|章)/u.test(text)) override.continuationDestination = "current";
  if (/节奏差异/u.test(text)) override.direction = "pacing";
  else if (/情绪差异/u.test(text)) override.direction = "emotion";
  else if (/叙事视角差异|视角差异/u.test(text)) override.direction = "perspective";
  else if (/自由发挥/u.test(text)) override.direction = "free";
  return Object.keys(override).length ? override : null;
};

export const supersedeConversationChoiceInstructions = (messages = [], latestInstruction = "") => {
  const latest = conversationChoiceOverrideFromInstruction(latestInstruction);
  if (!latest) return Array.isArray(messages) ? messages : [];
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message?.conversationChoiceInstruction !== true) return message;
    const previous = conversationChoiceOverrideFromInstruction(message.content);
    if (!previous) return message;
    const conflicts = Object.keys(latest).some((key) => (
      Object.hasOwn(previous, key) && previous[key] !== latest[key]
    ));
    if (!conflicts) return message;
    return { ...message, choiceSuperseded: true, contextEligible: false };
  });
};

export const conversationChoiceUserInstruction = ({ label = "", value = "" } = {}) => (
  String(label || value || "").trim()
);

const cleanChoice = (value = "") => String(value || "")
  .replace(/^\s*(?:[-—–•·*]+\s*|(?:\d+|[A-ZＡ-Ｚ]|[一二三四五六七八九十]+)[.、：:)）]\s*)/u, "")
  .replace(/^(?:题材|类型|方案|方向|选项)\s*[：:]\s*/u, "")
  .split(/[，,。；;？?！!]/u)[0]
  .trim();

export const assistantChoicePrompt = () => null;

export const structuredCreativeGuidanceChoice = (execution = {}) => {
  const state = execution?.guidanceState;
  if (!state || state.interactionMode !== "choice_fallback") return null;
  const options = (Array.isArray(state.candidateOptions) ? state.candidateOptions : [])
    .filter((option) => option && typeof option === "object" && String(option.label || "").trim())
    .slice(0, 3);
  if (options.length < 2) return null;
  return {
    question: String(execution.choiceQuestion || state.pendingReflectionQuestion || "请选择更接近你当前判断的方向。").trim(),
    options,
  };
};

export const isCandidateComparisonOpenRequest = (instruction = "") => /^(?:请)?(?:打开|显示|查看|回到)(?:当前)?(?:的)?(?:候选稿?|候选对比|候选窗口|候选稿预览)(?:窗口)?[。！!\s]*$/u.test(String(instruction || "").trim());

const cleanWriters = (writers = []) => (Array.isArray(writers) ? writers : [])
  .map((writer) => ({
    id: String(writer?.id || "").trim(),
    name: String(writer?.name || writer?.id || "").trim(),
    role: String(writer?.role || "").trim(),
    version: String(writer?.version || "").trim(),
    sourceLabel: String(writer?.sourceLabel || writer?.source || "").trim(),
  }))
  .filter((writer) => writer.id && writer.name)
  .filter((writer, index, list) => list.findIndex((item) => item.id === writer.id) === index);

export const createConversationChoiceState = ({ prompt = "", writers = [] } = {}) => ({
  prompt: String(prompt || "").trim(),
  step: "writer_mode",
  writerMode: "",
  direction: "free",
  count: 2,
  writers: cleanWriters(writers),
  selectedWriterIds: [],
  countsByWriter: {},
  customNote: "",
});

export const selectConversationChoice = (state, selection = {}) => {
  const current = { ...createConversationChoiceState(state), ...state };
  const type = String(selection.type || "");
  if (type === "writer_mode" && WRITER_MODES.has(selection.value)) {
    const writerMode = selection.value;
    return { ...current, writerMode, step: writerMode === "multiple" ? "writers" : "direction" };
  }
  if (type === "direction" && DIRECTIONS.has(selection.value) && current.writerMode === "single") {
    return { ...current, direction: selection.value, step: "candidate_count" };
  }
  if (type === "candidate_count" && COUNTS.has(Number(selection.value)) && current.writerMode === "single") {
    return { ...current, count: Number(selection.value), step: "confirm" };
  }
  if (type === "writers" && current.writerMode === "multiple") {
    const allowed = new Set(current.writers.map((writer) => writer.id));
    const selectedWriterIds = [...new Set((Array.isArray(selection.value) ? selection.value : []).map(String))]
      .filter((id) => allowed.has(id));
    if (!selectedWriterIds.length) return current;
    return { ...current, selectedWriterIds, step: "writer_counts" };
  }
  if (type === "writer_counts" && current.writerMode === "multiple") {
    const selected = new Set(current.selectedWriterIds);
    const countsByWriter = Object.fromEntries(Object.entries(selection.value && typeof selection.value === "object" ? selection.value : {})
      .filter(([id, value]) => selected.has(id) && COUNTS.has(Number(value)))
      .map(([id, value]) => [id, Number(value)]));
    if (Object.keys(countsByWriter).length !== selected.size) return current;
    return { ...current, countsByWriter, step: "confirm" };
  }
  return current;
};

export const candidateGenerationRequest = (state = {}) => {
  const current = { ...createConversationChoiceState(state), ...state };
  if (current.step !== "confirm" || !current.prompt) return null;
  if (current.writerMode === "multiple") {
    return {
      prompt: current.prompt,
      writerMode: "multiple",
      writerIds: [...current.selectedWriterIds],
      countsByWriter: { ...current.countsByWriter },
      direction: current.direction,
      customNote: String(current.customNote || "").trim(),
    };
  }
  return {
    prompt: current.prompt,
    writerMode: "single",
    count: Number(current.count) || 2,
    direction: DIRECTIONS.has(current.direction) ? current.direction : "free",
    customNote: String(current.customNote || "").trim(),
  };
};

export const conversationChoiceStepLabel = (step = "") => ({
  writer_mode: "先选择主笔数量",
  direction: "选择候选差异方向",
  candidate_count: "核对候选稿数量",
  writers: "选择参与生成的主笔",
  writer_counts: "分别核对每个主笔的候选数量",
  confirm: "确认后开始生成候选稿",
}[step] || "");
