import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-official-skill-library-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

try {
  const { listManagedSkills, loadOfficialSkill } = await import("../src/server/skill-store.mjs");
  const shensiRoot = fileURLToPath(new URL("../packaging/bundled/skill/神思/", import.meta.url));
  const catalog = await listManagedSkills({ shensiRoot });

  assert.ok(catalog.officialCapabilityTemplate?.template, "官方面板必须作为独立只读目录返回");
  assert.equal(catalog.marketplace.items.some((item) => item.trustLevel === "official" || item.sourceType === "official"), false, "Skill 广场不得混入官方项目");
  assert.equal(catalog.marketplace.items.some((item) => (item.assetType || "skill") !== "skill"), false, "Skill 广场只展示用户 Skill");

  const prompt = catalog.officialCapabilityTemplate.modules.find((module) => module.id === "module:prompt-writer");
  const video = catalog.officialCapabilityTemplate.modules.find((module) => module.id === "module:video-prompt-writer");
  assert.equal(prompt.slots.some((slot) => slot.skillId === "builtin:prompt-writer"), false);
  assert.deepEqual(video.slots.map((slot) => slot.skillId), ["builtin:video-prompt-writer"]);
  assert.equal(video.slots[0].name, "AI 视频导演（二）");

  const directorTwo = await loadOfficialSkill({ id: "builtin:video-prompt-writer", shensiRoot });
  assert.equal(directorTwo.name, "AI 视频导演（二）");
  assert.match(directorTwo.content, /视频导演二（30秒）/u);
  assert.match(directorTwo.content, /画面硬切/u);

  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /const renderOfficialCapabilityLibrary =/u);
  assert.match(app, /官方能力随软件直接内置，不占用 Skill 广场/u);
  assert.match(app, /skill\.trustLevel !== "official"/u);
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}

console.log("official Skill hierarchy and user-only marketplace boundary checks passed");
