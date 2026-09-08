import assert from "node:assert/strict";
import { resolveSkillRuntime, skillPromptForStage } from "../src/skill-routing.js";

const skills = [
  {
    id: "builtin:novel-writer",
    name: "小说正文主笔",
    slotName: "小说正文主笔",
    capabilities: ["novel_prose_writer"],
    workspaceModes: ["project"],
    content: "DEFAULT_WRITER_RULES",
    testStatus: "passed",
    activationSource: "capability_template_builtin",
  },
  {
    id: "builtin:effect-review",
    name: "小说自检",
    slotName: "小说自检模块",
    capabilities: ["effect_reviewer"],
    workspaceModes: ["project"],
    content: "REVIEW_RULES",
    testStatus: "passed",
    activationSource: "capability_template_builtin",
  },
  {
    id: "builtin:story-planner",
    name: "故事与大纲规划主笔",
    slotName: "故事与大纲规划主笔",
    capabilities: ["story_planner"],
    workspaceModes: ["project"],
    content: "PLANNER_RULES",
    testStatus: "passed",
    activationSource: "capability_template_builtin",
  },
  {
    id: "builtin:theory-advisor",
    name: "题材理论顾问",
    slotName: "题材理论顾问",
    capabilities: ["theory_advisor"],
    workspaceModes: ["project"],
    content: "THEORY_RULES",
    testStatus: "passed",
    activationSource: "capability_template_builtin",
  },
  {
    id: "builtin:short-video-writer",
    name: "短视频剧本主笔",
    slotName: "短视频剧本主笔",
    capabilities: ["short_video_script_writer"],
    workspaceModes: ["project"],
    content: "SHORT_VIDEO_RULES",
    testStatus: "passed",
    activationSource: "capability_template_builtin",
  },
  {
    id: "builtin:illustration-planner",
    name: "Ian小黑正文配图",
    slotName: "Ian小黑正文配图",
    capabilities: ["article_illustration_planner"],
    workspaceModes: ["project"],
    content: "ILLUSTRATION_RULES",
    testStatus: "passed",
    activationSource: "capability_template_builtin",
  },
];

const runtimeFor = (prompt) => resolveSkillRuntime({
  skills,
  workspaceMode: "project",
  activeModule: "manuscript",
  prompt,
  requestMode: "creative",
  contextDomain: "novel",
});

const runtimeForNotebook = (prompt) => resolveSkillRuntime({
  skills,
  workspaceMode: "project",
  activeModule: "notebook",
  prompt,
  requestMode: "creative",
  contextDomain: "note",
});

const normal = runtimeFor("请写正文");
assert.equal(normal.primarySkill.name, "小说正文主笔");
assert.equal(normal.writerRoleOverride, undefined);
assert.match(skillPromptForStage(normal, "creative"), /DEFAULT_WRITER_RULES/u);
assert.doesNotMatch(skillPromptForStage(normal, "creative"), /REVIEW_RULES/u);

const reviewAsWriter = runtimeFor("请强制使用小说自检模块的规则作为主笔写正文");
assert.equal(reviewAsWriter.primarySkill.name, "小说自检");
assert.equal(reviewAsWriter.writerRoleOverride.applied, true);
assert.equal(reviewAsWriter.writerRoleOverride.temporary, true);
assert.match(skillPromptForStage(reviewAsWriter, "creative"), /本轮临时指定主笔/u);
assert.match(skillPromptForStage(reviewAsWriter, "creative"), /REVIEW_RULES/u);
assert.doesNotMatch(skillPromptForStage(reviewAsWriter, "creative"), /DEFAULT_WRITER_RULES/u);
assert.match(skillPromptForStage(reviewAsWriter, "evaluation"), /用户创意效果主审/u);

const plannerAsWriter = runtimeFor("请让故事与大纲规划主笔作为主笔写正文");
assert.equal(plannerAsWriter.primarySkill.name, "故事与大纲规划主笔");
assert.equal(plannerAsWriter.writerRoleOverride.applied, true);
assert.match(skillPromptForStage(plannerAsWriter, "creative"), /PLANNER_RULES/u);

const shortVideoAsWriter = runtimeFor("请让短视频编剧 Skill 作为主笔写短剧剧本");
assert.equal(shortVideoAsWriter.primarySkill.name, "短视频剧本主笔");
assert.equal(shortVideoAsWriter.slotRoleOverride.targetSlot, "writer");
assert.match(skillPromptForStage(shortVideoAsWriter, "creative"), /SHORT_VIDEO_RULES/u);

const writerAsReviewer = runtimeFor("请让小说正文主笔作为自检模块检查前三章");
assert.equal(writerAsReviewer.primarySkill.name, "小说正文主笔");
assert.equal(writerAsReviewer.slotRoleOverride.targetSlot, "effectReview");
assert.equal(writerAsReviewer.slotSkills.effectReview.name, "小说正文主笔");
assert.match(skillPromptForStage(writerAsReviewer, "evaluation"), /DEFAULT_WRITER_RULES/u);

const writerAsPlanner = runtimeFor("请让小说正文主笔作为大纲规划生成大纲");
assert.equal(writerAsPlanner.primarySkill.name, "小说正文主笔");
assert.equal(writerAsPlanner.slotRoleOverride.targetSlot, "planning");
assert.equal(writerAsPlanner.slotSkills.planning.name, "小说正文主笔");
assert.match(skillPromptForStage(writerAsPlanner, "planning"), /DEFAULT_WRITER_RULES/u);

const writerAsGenreReviewer = runtimeFor("请让小说正文主笔作为题材审查检查前三章");
assert.equal(writerAsGenreReviewer.slotRoleOverride.targetSlot, "genreReviews");
assert.equal(Array.isArray(writerAsGenreReviewer.slotSkills.genreReviews), true);
assert.equal(writerAsGenreReviewer.slotSkills.genreReviews[0].name, "小说正文主笔");
assert.match(skillPromptForStage(writerAsGenreReviewer, "evaluation"), /DEFAULT_WRITER_RULES/u);

const notebookOverride = runtimeForNotebook("请让短视频编剧 Skill 作为主笔写一段笔记");
assert.equal(notebookOverride.primarySkill.name, "短视频剧本主笔");
assert.equal(notebookOverride.slotRoleOverride.targetSlot, "writer");

const incompatible = runtimeFor("请让Ian小黑正文配图作为主笔写正文");
assert.equal(incompatible.primarySkill.name, "小说正文主笔");
assert.equal(incompatible.writerRoleOverride.applied, false);
assert.equal(incompatible.writerRoleOverride.incompatible, true);
assert.match(skillPromptForStage(incompatible, "creative"), /不具备/u);

const artifactOverride = runtimeFor("请让Ian小黑正文配图作为配图规划生成配图提示词");
assert.equal(artifactOverride.slotRoleOverride.targetSlot, "artifactPlanning");
assert.equal(Array.isArray(artifactOverride.slotSkills.artifactPlanning), true);
assert.equal(artifactOverride.slotSkills.artifactPlanning[0].name, "Ian小黑正文配图");

const question = runtimeFor("能不能让小说自检模块作为主笔？");
assert.equal(question.primarySkill.name, "小说正文主笔");
assert.equal(question.writerRoleOverride, undefined);

const unnamed = runtimeFor("请强制使用一个不存在的自检模块作为主笔写正文");
assert.equal(unnamed.primarySkill.name, "小说正文主笔");
assert.equal(unnamed.writerRoleOverride.applied, false);

const ambiguous = runtimeFor("请让自检和理论顾问共同作为主笔写正文");
assert.equal(ambiguous.primarySkill.name, "小说正文主笔");
assert.equal(ambiguous.writerRoleOverride.applied, false);

console.log("explicit writer role override contracts passed");
