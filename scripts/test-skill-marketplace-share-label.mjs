import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const app = await readFile(resolve(root, "src/app.js"), "utf8");
const styles = await readFile(resolve(root, "src/styles.css"), "utf8");

assert.match(app, /data-skill-context-action="share"[^>]*>[\s\S]{0,120}<span>分享到Skill广场<\/span>/u,
  "Skill 右键菜单的分享按钮必须统一显示“分享到Skill广场”");
assert.match(app, /data-capability-context-action="share"[^>]*>[\s\S]{0,120}<span>分享到Skill广场<\/span>/u,
  "模块或模组右键菜单的分享按钮必须统一显示“分享到Skill广场”");
assert.match(app, /share\.querySelector\("span:last-child"\)\.textContent = officialOriginal \? "官方原版无需分享" : "分享到Skill广场"/u,
  "Skill 上下文菜单动态标签必须统一显示“分享到Skill广场”");
assert.match(app, /id="shareSkillToMarketplace"[\s\S]{0,160}<span>分享到Skill广场<\/span>/u,
  "Skill 广场主分享按钮必须显示“分享到Skill广场”");
assert.equal((app.match(/id="shareSkillToMarketplace"/gu) ?? []).length, 1,
  "Skill 广场只能存在一个主分享按钮");
assert.doesNotMatch(app, /id="shareSkillToMarketplace"[^>]*>[\s\S]{0,80}\$\{icon\(/u,
  "Skill 广场主分享按钮不得保留会挤成竖排文案的旧图标节点");
assert.match(app, /marketplaceShareLabel\) marketplaceShareLabel\.textContent = "分享到Skill广场"/u,
  "Skill 广场重绘后的主分享按钮不得恢复旧文案");
assert.match(styles, /\.marketplace-share-actions\s*\{[\s\S]{0,240}width:\s*max-content;[\s\S]{0,120}min-width:\s*max-content;/u,
  "Skill 广场分享操作区必须按内容宽度展开");
assert.match(styles, /#shareSkillToMarketplace\s*\{[\s\S]{0,260}min-width:\s*max-content;[\s\S]{0,120}white-space:\s*nowrap;[\s\S]{0,120}word-break:\s*keep-all;[\s\S]{0,120}writing-mode:\s*horizontal-tb;/u,
  "Skill 广场主分享按钮必须保持横排且禁止逐字换行");

console.log("skill marketplace share label contract passed");
