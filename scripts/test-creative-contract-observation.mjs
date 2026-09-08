import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  creativeContractObservationProposal,
  mergeCreativeContractObservation,
} from "../src/creative-contract-observation.js";

const proposal = creativeContractObservationProposal({
  type: "shensi_native_review",
  candidateHash: "candidate-hash",
  findings: [{
    fingerprint: "finding-1",
    dimension: "language",
    status: "open",
    diagnosis: "“仿佛”在相邻段落频繁出现，形成重复句式。",
    repairInstruction: "避免连续使用“仿佛”起句；改用人物动作或具体感官承接。",
  }],
});

assert.equal(proposal?.contractField, "specialNotes");
assert.match(proposal?.suggestedRule || "", /避免连续使用/u);
assert.equal(proposal?.candidateHash, "candidate-hash");
assert.equal(creativeContractObservationProposal({
  type: "shensi_native_review",
  findings: [{ dimension: "continuity", diagnosis: "人物年龄冲突" }],
}), null, "非语言重复问题不能触发创作合同确认");

const merged = mergeCreativeContractObservation("现有规则。", proposal);
assert.match(merged, /现有规则/u);
assert.match(merged, /避免连续使用/u);
assert.equal(mergeCreativeContractObservation(merged, proposal), merged, "同一规则不得重复写入");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(app, /creativeContractObservationProposal\(rawReply\?\.reviewArtifact,\s*\{/u, "自动落盘后必须检查创作合同建议");
assert.doesNotMatch(app, /await\s+promptCreativeContractObservation/u, "创作合同选择不得阻断当前正文写入");
assert.match(app, /value === "persist"[\s\S]{0,500}saveCreativeContractObservation/u, "只有明确确认时写入创作合同");
assert.match(app, /本次避免/u, "本轮规则必须可只在当前任务生效");
assert.match(app, /写入创作合同/u, "必须保留明确持久化入口");
assert.match(app, /暂不记录/u, "暂不记录也必须继续当前任务");
assert.match(app, /conversationChoicePanel/u, "需要追问时必须使用对话内统一选项面板");
assert.doesNotMatch(app, /id="creativeChoiceDialog"/u, "对话选项不应再使用独立弹窗");
assert.match(app, /其他要求可以直接在下方对话框中输入/u, "选项栏必须保留对话输入路径，不显示底层逻辑");
assert.match(app, /appendConversationChoiceInstruction/u, "点选内容必须写入对话记录");
assert.match(styles, /\.conversation-choice-options/u);

console.log("creative contract observation confirmation regressions passed");
