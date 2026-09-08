import { executionSourceIdentity, executionSourceMarker } from "./execution-source-proof.mjs";

const cleanId = (value = "") => String(value || "").trim();

export const agentSkillSelectionId = (selection = "") => cleanId(
  typeof selection === "string" ? selection : selection?.id || selection?.relativePath,
);

export const agentSkillSelectionEnabled = (selection = "") => typeof selection === "string"
  || (selection?.enabled !== false && selection?.disabled !== true);

const SKILL_TERM = /(?:@?\s*skill|技能)/iu;
const SKILL_NEGATION = /(?:不要|无需|不必|禁止|取消|不用|(?:^|[，。！？；;\s])别).{0,16}(?:@?\s*skill|技能)/iu;
const SKILL_PROVENANCE_QUERY = /(?:(?:这|那|本|前|上|刚才|之前|此前|已经|曾经|实际|分别).{0,30})?(?:使用|调用|加载|匹配|运行)(?:了|过|到)?[^。！？\n]{0,36}(?:哪些|什么|哪一个|哪个|多少)[^。！？\n]{0,18}(?:@?\s*skill|技能)|(?:哪些|什么|哪一个|哪个|多少)[^。！？\n]{0,18}(?:@?\s*skill|技能)[^。！？\n]{0,30}(?:使用|调用|加载|匹配|运行)(?:了|过)?/iu;
const SKILL_DIAGNOSTIC_QUERY = /(?:检查|诊断|研究|分析|为什么|为何|是否|能否|可否|有没有|记录|日志).{0,28}(?:@?\s*skill|技能).{0,18}(?:调用|运行|识别|有效|可用|命中|记录)|(?:@?\s*skill|技能).{0,24}(?:是什么|有哪些|为何|为什么|是否|能否|调用了|使用了|记录|日志)/iu;
const SKILL_EXECUTION_REQUEST = /(?:使用|调用|执行|加载|通过|按照|请选择|选择|启用|自动匹配).{0,24}(?:@?\s*skill|技能)|(?:@?\s*skill|技能).{0,16}(?:使用|调用|执行|加载|匹配|启用)/iu;
const EXECUTION_PROVENANCE_QUERY = /(?:(?:本次|这次|此次|当前|刚才|之前|前面|这几章|这些章节|各章|分别|实际).{0,24})?(?:读取|参考|使用|调用|加载)(?:了|过|到)?[^。！？\n]{0,36}(?:哪些|什么|哪一个|哪个|多少)(?:资料|来源|文档|内容|@?\s*skill|技能|规则)|(?:哪些|什么|哪一个|哪个|多少)(?:资料|来源|文档|内容|@?\s*skill|技能|规则)[^。！？\n]{0,36}(?:读取|参考|使用|调用|加载)(?:了|过)?/iu;

export const agentPromptRequestsExecutionProvenance = (prompt = "") => EXECUTION_PROVENANCE_QUERY.test(String(prompt || "").trim())
  || agentSkillPromptIntent(prompt) === "provenance_query";

export const agentSkillPromptIntent = (prompt = "") => {
  const text = String(prompt || "").trim();
  if (!text || !SKILL_TERM.test(text)) return "none";
  if (SKILL_NEGATION.test(text)) return "negated";
  if (SKILL_PROVENANCE_QUERY.test(text) || SKILL_DIAGNOSTIC_QUERY.test(text)) return "provenance_query";
  if (SKILL_EXECUTION_REQUEST.test(text)) return "execution_request";
  return "mention";
};

const skillIdentityCandidates = (value = {}) => {
  const ids = [
    value?.id,
    value?.relativePath,
    value?.skillId,
    value?.managedSkillId,
  ].map(cleanId).filter(Boolean);
  return new Set(ids.flatMap((id) => id.startsWith("user:") ? [id, id.slice(5)] : [id, `user:${id}`]));
};

export const agentPromptRequiresSkillSelection = (prompt = "", selectedSkills = []) => {
  if ((Array.isArray(selectedSkills) ? selectedSkills : []).some((selection) => agentSkillSelectionId(selection))) return false;
  return agentSkillPromptIntent(prompt) === "execution_request";
};

export const loadAgentSkillContext = async ({ selectedSkills = [], loadSkills, shensiRoot = "" } = {}) => {
  const requestedSelections = (Array.isArray(selectedSkills) ? selectedSkills : [])
    .filter(agentSkillSelectionEnabled)
    .filter((selection, index, values) => {
      const id = agentSkillSelectionId(selection);
      return id && values.findIndex((candidate) => agentSkillSelectionId(candidate) === id) === index;
    });
  if (!requestedSelections.length) return { requestedIds: [], loadedSkills: [], missingIds: [], contextBlocks: [] };
  if (typeof loadSkills !== "function") throw new Error("Agent Skill 加载器不可用");
  const loadedSkills = (await loadSkills(requestedSelections, { shensiRoot })).map((skill) => {
    const content = String(skill?.content ?? "").trim();
    const skillReadFailures = Array.isArray(skill?.skillReadFailures) ? skill.skillReadFailures : [];
    const identity = executionSourceIdentity({
      kind: "skill",
      id: cleanId(skill?.id || skill?.relativePath || skill?.skillId),
      version: skill?.version || skill?.revision || "current",
      content,
    });
    return {
      ...skill,
      ...identity,
      content,
      skillReadFailures,
      fullText: Boolean(content)
        && skill?.truncated !== true
        && skillReadFailures.length === 0
        && skill?.fullSourceRead !== false,
    };
  });
  const loadedIdentitySets = loadedSkills.filter((skill) => skill.fullText).map(skillIdentityCandidates);
  const missingIds = requestedSelections
    .map(agentSkillSelectionId)
    .filter((requestedId) => !loadedIdentitySets.some((ids) => ids.has(requestedId) || ids.has(requestedId.replace(/^user:/, ""))));
  return {
    requestedIds: requestedSelections.map(agentSkillSelectionId),
    loadedSkills,
    missingIds,
    contextBlocks: loadedSkills.filter((skill) => skill.fullText).map((skill) => ({
      type: "controlled_skill",
      id: cleanId(skill.id || skill.relativePath || skill.skillId),
      name: cleanId(skill.name || skill.slotName || skill.id || "Skill"),
      uri: cleanId(skill.relativePath || skill.id || skill.skillId),
      mimeType: "text/markdown",
      text: `${executionSourceMarker({ kind: "skill", id: skill.id, version: skill.version, content: skill.content })}\n${skill.content}`,
    })).filter((block) => block.id && block.text),
  };
};
