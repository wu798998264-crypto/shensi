import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

const executeStart = app.indexOf("const executeMessage = async");
const executeEnd = app.indexOf("const sendMessage = async", executeStart);
assert.ok(executeStart >= 0 && executeEnd > executeStart, "executeMessage source window must exist");
const executeSource = app.slice(executeStart, executeEnd);
assert.match(executeSource, /return await generateMediaFromComposer\(/u,
  "媒体执行结果必须透传到队列确认层");

const mediaStart = app.indexOf("const generateMediaFromComposer = async");
const mediaEnd = app.indexOf("const generateImageFromComposer", mediaStart);
assert.ok(mediaStart >= 0 && mediaEnd > mediaStart, "generateMediaFromComposer source window must exist");
const mediaSource = app.slice(mediaStart, mediaEnd);
assert.match(mediaSource, /dispatchNotAccepted\("attachments_still_uploading"\)/u,
  "附件上传期间媒体任务必须明确拒绝派发并保留队列项");
assert.match(mediaSource, /dispatchNotAccepted\("media_connection_not_selected"\)/u,
  "取消配置选择时媒体任务必须明确拒绝派发");
assert.match(mediaSource, /dispatchAccepted: durableJobCount > 0 \|\| failedRequestCount >= mediaRequests\.length/u,
  "媒体队列只有在创建持久化任务或记录完整失败后才能确认");
assert.match(mediaSource, /durableJobCount \+= 1/u,
  "每个已创建的持久化媒体任务必须计入派发结果");
assert.match(mediaSource, /failedRequestCount \+= 1/u,
  "每个明确失败的媒体请求必须计入派发结果");

const sendStart = app.indexOf("const sendMessage = async");
const sendEnd = app.indexOf("const switchConversationMode", sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, "sendMessage source window must exist");
const sendSource = app.slice(sendStart, sendEnd);
assert.match(sendSource, /result\?\.dispatchAccepted === false[\s\S]{0,180}nackQueuedConversationItem/u,
  "未接受的派发结果必须退回队列");
assert.match(sendSource, /queueDrainAfterExecution = result\.reason === "attachments_still_uploading"/u,
  "用户取消或配置未就绪时不得立即重复派发队列项");
assert.match(sendSource, /if \(queueDrainAfterExecution\) scheduleConversationQueueDrain\(conversation\.id, \{ delayMs: queueDrainDelayMs \}\)/u,
  "队列排空必须服从派发结果决定的重试时机");
assert.match(sendSource, /error\?\.code === "ATTACHMENTS_STILL_UPLOADING"[\s\S]{0,500}queueDrainDelayMs = 500/u,
  "附件上传竞争失败后必须延迟唤醒队列，避免队列项永久停在 dispatching");

const agentStart = app.indexOf("const sendCodexAgentMessage = async");
const agentEnd = app.indexOf("const switchConversationMode", agentStart);
assert.ok(agentStart >= 0 && agentEnd > agentStart, "sendCodexAgentMessage source window must exist");
const agentSource = app.slice(agentStart, agentEnd);
assert.match(agentSource, /if \(conversation\.id === state\.activeConversationId && ui\.uploadingAttachments\)/u,
  "Agent 派发路径必须检查活动附件上传状态");
assert.match(agentSource, /if \(queuedItem\) nackQueuedConversationItem\(conversation, queuedItem, error\)/u,
  "Agent 附件上传竞争必须退回原队列项");

console.log("conversation media queue lifecycle tests passed");
