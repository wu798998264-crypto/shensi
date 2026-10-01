import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const app = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

const topbarMarkup = app.match(/<header class="topbar[^>]*>[\s\S]*?<\/header>/u)?.[0] || "";
assert.match(topbarMarkup, /class="topbar v804-fixed-layout"/u, "顶部栏必须使用 8.0.4 固定布局标记");
assert.ok(topbarMarkup.indexOf('class="project-switcher"') < topbarMarkup.indexOf('class="global-search"'), "作品目录按钮必须位于搜索框左侧");
assert.match(topbarMarkup, /id="projectButton"/u, "顶部必须保留作品/笔记本目录入口");
assert.match(topbarMarkup, /id="globalSearch"/u, "顶部必须保留全局搜索框");

const fixedLayout = styles.match(/\.topbar\.v804-fixed-layout\s*\{[\s\S]*?\n\}/u)?.[0] || "";
assert.match(fixedLayout, /--v804-project-slot:\s*300px/u, "桌面目录槽位必须为 300px");
assert.match(fixedLayout, /--v804-search-width:\s*720px/u, "桌面搜索框宽度必须为 720px");
assert.match(fixedLayout, /grid-template-columns:\s*auto 1px var\(--v804-project-slot\) minmax\(0, 1fr\) auto auto/u, "顶部栏必须使用固定六列布局");

const searchLayout = styles.match(/\.topbar\.v804-fixed-layout \.global-search,[\s\S]*?\.topbar\.editor-search-anchored \.global-search\s*\{[\s\S]*?\n\}/u)?.[0] || "";
assert.match(searchLayout, /left:\s*50%/u, "搜索框必须相对顶部栏水平居中");
assert.match(searchLayout, /width:\s*var\(--v804-search-width, 720px\)/u, "搜索框必须使用固定基准宽度");
assert.doesNotMatch(searchLayout, /editor-search-center-x/u, "搜索框不能依赖编辑区动态中心点");
assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*?--v804-search-width:\s*260px/u, "窄窗口必须使用不遮挡右侧工具的固定规格");

const syncStart = app.indexOf("const syncGlobalSearchAnchor = () => {");
const syncEnd = app.indexOf("\n};", syncStart);
const syncBody = syncStart >= 0 && syncEnd > syncStart ? app.slice(syncStart, syncEnd) : "";
assert.ok(syncBody, "必须存在顶部搜索布局同步函数");
assert.doesNotMatch(syncBody, /getBoundingClientRect|editorRect|projectRect|topActionsRect/u, "搜索布局同步不能读取面板尺寸");

assert.match(app, /const fullscreenAvailable = !workspaceHasNoActiveEntry\(\)[\s\S]*?elements\.whiteboardFullscreenButton\.hidden = !fullscreenAvailable/u, "打开文档后全屏状态必须保留退出全屏按钮");
assert.match(app, /const isTools = child === elements\.sidebarTools;[\s\S]*?child\.inert = leftSidebarCollapsed && !isTools/u, "目录收起时底部工具按钮不能被设为 inert");
assert.match(styles, /\.workspace\.left-sidebar-collapsed > \.left-sidebar > :not\(\.sidebar-tools\)[\s\S]*?visibility:\s*hidden/u, "目录收起时只能隐藏非工具内容");
assert.match(styles, /\.workspace\.left-sidebar-collapsed \.sidebar-tools[\s\S]*?pointer-events:\s*auto/u, "目录收起时工具组必须可点击");
assert.match(styles, /\.workspace\.left-sidebar-collapsed \.sidebar-tools[\s\S]*?left:\s*14px[\s\S]*?bottom:\s*6px/u, "普通模式收起目录后的工具组必须保留底部边距");
assert.match(styles, /\.app-shell\.editor-fullscreen-active \.workspace\.left-sidebar-collapsed \.sidebar-tools[\s\S]*?bottom:\s*1px/u, "全屏模式收起目录后的工具组必须位于横线下方");

console.log("test-v804-topbar-layout: PASS");
