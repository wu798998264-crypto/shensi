import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appSource, serverSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
]);

assert.match(
  appSource,
  /whiteboardContext:\s*whiteboardIsolated\s*\?\s*\{\s*source:\s*"canvas"/u,
  "白板请求必须显式声明画布上下文",
);
assert.match(
  serverSource,
  /const whiteboardCanvasContext = whiteboardOutputSurface[\s\S]{0,260}body\.whiteboardContext\?\.source === "canvas"[\s\S]{0,180}白板生成输入范围/u,
  "服务端必须识别画布上下文请求",
);
assert.match(
  serverSource,
  /body\.settings\?\.workspacePath && !whiteboardCanvasContext/u,
  "白板请求不能被工作区文档重读覆盖",
);
assert.match(
  serverSource,
  /else if \(whiteboardCanvasContext\)[\s\S]{0,360}contextGate = contextGate \|\| \{ status: "ready"/u,
  "白板上下文保留后必须进入可执行状态",
);

const textGeneration = appSource.match(/requestModelReply\(\{ documentId: sourceDocumentId, moduleId: "library", contextDomain: generationRoute\.contextDomain \|\| "general" \}[\s\S]{0,900}?modelAttachments,/u);
assert.ok(textGeneration, "文字生成必须把白板生成上下文中的附件传入请求");
assert.match(
  appSource,
  /const whiteboardMediaPrompt = \(\{ prompt,[\s\S]{0,260}textSources\.map\(\(source\) => `【用户引用原文：/u,
  "图片和视频提示词必须使用上游文字来源",
);
const mediaSubmissionStart = appSource.indexOf("const buildWhiteboardMediaProviderPrompt = async");
const mediaSubmissionEnd = appSource.indexOf("const whiteboardResolvedAspectRatio", mediaSubmissionStart);
assert.ok(mediaSubmissionStart >= 0 && mediaSubmissionEnd > mediaSubmissionStart, "图片和视频必须具有独立的本地提示词准备边界");
const mediaSubmissionSource = appSource.slice(mediaSubmissionStart, mediaSubmissionEnd);
assert.doesNotMatch(
  mediaSubmissionSource,
  /requestModelReply|selectedSkills|skill-route/u,
  "图片和视频读取普通上游文字时不能调用文字模型或 Skill",
);
assert.match(
  appSource,
  /const whiteboardMediaTextSources[\s\S]{0,260}!node \|\| \["skill", "capability"\]\.includes/u,
  "图片和视频提示词必须排除 Skill、模块和模组卡片",
);

console.log("白板文字上游与媒体普通参考隔离契约测试通过");
