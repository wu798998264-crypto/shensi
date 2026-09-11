import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

const composerStart = app.indexOf('<div class="chat-composer-stack">');
const choiceStart = app.indexOf('id="conversationChoicePanel"');
const formStart = app.indexOf('id="chatForm"');
assert.ok(composerStart > 0 && choiceStart > composerStart && choiceStart < formStart, "所有对话选项必须位于输入区容器内、聊天表单正上方");

const quickAgentFields = app.slice(app.indexOf('id="quickAgentFields"'), app.indexOf('id="quickCodexConnection"'));
for (const label of ["文字配置", "文字模型", "检查当前 Agent", "推理强度", "响应速度", "更换目录"]) {
  assert.match(quickAgentFields, new RegExp(label, "u"), `统一 Agent 必须保留完整的快捷模型选择能力：${label}`);
}

const codexSelectionStart = app.indexOf("const currentCodexConnectionSelected");
const codexSelectionEnd = app.indexOf("const syncChatModeOptions", codexSelectionStart);
assert.match(app.slice(codexSelectionStart, codexSelectionEnd), /shouldShowCodexAccountControls/u, "Codex 登录入口必须使用统一的 OpenAI CLI 身份策略限制");
assert.match(app, /elements\.quickCodexConnection\.hidden\s*=\s*!selected\s*\|\|\s*connected/u, "Codex 已连接后必须恢复原版界面并隐藏整个登录区");

const optionCss = css.slice(css.indexOf(".conversation-choice-option {"), css.indexOf(".conversation-choice-option:hover"));
assert.match(optionCss, /flex:\s*0 0 auto/u, "选项不得拉伸成大方格");
assert.match(optionCss, /min-height:\s*(?:28|30|32)px/u, "选项按钮高度必须紧凑");
assert.match(optionCss, /border-radius:\s*999px/u, "选项按钮应采用参考图的紧凑胶囊形状");

const choiceButtonStart = app.indexOf("const conversationChoiceButton");
const choiceButtonEnd = app.indexOf("const renderConversationChoicePanel", choiceButtonStart);
assert.doesNotMatch(optionCss, /flex-direction:\s*column/u, "选项内部不得纵向堆叠成大方格");
assert.match(optionCss, /white-space:\s*nowrap/u, "选项按钮必须保持单行紧凑布局");
assert.doesNotMatch(app.slice(choiceButtonStart, choiceButtonEnd), /title=/u, "选项按钮不得通过悬停文案解释底层流程");
assert.match(css, /\.conversation-choice-question\s*\{[^}]*display:\s*none/su, "选项问题已经进入聊天记录，选项栏不应重复显示");
assert.match(app, /其他要求可以直接在下方对话框中输入。/u, "选项栏必须只保留统一的手动输入提示");
for (const forbidden of ["不会自动落盘", "最终确认开始生成", "合同只在确认写入时更新", "选择后会继续下一步"]) {
  assert.doesNotMatch(app.slice(app.indexOf("const renderConversationChoicePanel"), app.indexOf("const renderCandidateComparison")), new RegExp(forbidden, "u"), `选项栏不得显示底层逻辑：${forbidden}`);
}

console.log("original quick model and compact choice layout regressions passed");
