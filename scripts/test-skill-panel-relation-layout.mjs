import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(appSource, /const renderCapabilityRelationBoard = \(scope, bundle\) => \{/u);
assert.match(appSource, /capability-relation-parallel/u);
assert.match(appSource, /capability-relation-primary-secondary/u);
assert.match(appSource, /capability-relation-organization/u);
assert.match(appSource, /data-capability-scope-type=/u);
assert.match(appSource, /data-capability-scope-id=/u);
assert.match(appSource, /data-relation-type=/u);
assert.match(appSource, /data-relation-role=/u);
assert.match(appSource, /data-capability-role-zone="\$\{leadRole\}"/u);

assert.match(appSource, /const capabilityMemberDropOperation = \(source, target, clientX\) => \{/u);
assert.match(appSource, /source\.scopeType !== target\.scopeType \|\| source\.scopeId !== target\.scopeId/u,
  "拖拽必须在 UI 层拒绝跨模块、跨模组或跨面板目标");
assert.match(appSource, /roles\.has\(leadRole\) && roles\.has\(subordinateRole\)[\s\S]{0,200}type: "swap"/u,
  "主要/上位节点与次要/下位节点之间必须选择精确交换");
assert.match(appSource, /source\.relationRole === subordinateRole && target\.relationRole === subordinateRole[\s\S]{0,200}type: "reorder"/u,
  "次要/下位节点之间必须保留前后排序");
assert.match(appSource, /swapCapabilityTemplateMembers\(bundle, operationInput\)/u);
assert.match(appSource, /替换主要节点/u);
assert.match(appSource, /替换上位节点/u);

assert.match(styles, /\.capability-relation-parallel,[\s\S]{0,160}grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u);
assert.match(styles, /\.capability-relation-primary-secondary \{[\s\S]{0,180}column-gap: 32px/u);
assert.match(styles, /\.capability-secondary-zone \.capability-relation-member-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
assert.match(styles, /\.capability-relation-organization \{[\s\S]{0,100}row-gap: 32px/u);
assert.match(styles, /\.capability-upper-zone \{[\s\S]{0,140}justify-self: center/u);
assert.match(styles, /\.capability-board-cell\[data-relation-role="primary"\],[\s\S]{0,140}border-width: 2px/u);
assert.match(styles, /\.capability-role-zone\.is-drop-swap::after \{[\s\S]{0,100}content: attr\(data-drop-label\)/u);
assert.match(styles, /@media \(max-width: 900px\) \{[\s\S]{0,300}\.capability-relation-primary-secondary \{\s*grid-template-columns: 1fr;\s*row-gap: 32px/u,
  "窄宽度下主次关系必须改成上下布局");

const legacyDragSection = appSource.slice(
  appSource.indexOf('elements.skillSettingsContent.addEventListener("dragstart", (event) => {', appSource.indexOf("draggingSkillSlotId")),
  appSource.indexOf('elements.skillSettingsContent.addEventListener("change", async (event) => {'),
);
assert.match(legacyDragSection, /String\(sourceSlot\.parentGroupId \|\| ""\) === String\(slotTarget\.dataset\.parentGroupId \|\| ""\)/u,
  "旧插槽列表也只能在同一父组内排序");
assert.doesNotMatch(legacyDragSection, /getData\("text\/plain"\)/u,
  "外部伪造的拖拽 ID 不得触发旧插槽移动");

console.log("Skill panel relation layout and scoped drag contracts passed");
