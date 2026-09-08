import { executionModeCapabilities } from "./model-execution-capabilities.js";

const normalizePrompt = (text = "") => String(text || "").trim().replace(/\s+/gu, " ");

export const chatAgentGuidanceKey = (text = "") => {
  const value = normalizePrompt(text);
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `chat-agent-${(hash >>> 0).toString(16)}`;
};

export const chatAgentModeAvailability = (profile = {}) => {
  const modes = executionModeCapabilities(profile, { existing: true }).modes;
  return {
    chat: modes.includes("chat"),
    agent: modes.includes("agent"),
    sameConnection: modes.includes("chat") && modes.includes("agent"),
  };
};

export const chatAgentGuidance = (text = "") => {
  const value = normalizePrompt(text);
  if (!value) return { recommended: false, reason: "empty", message: "" };
  const fileOperation = /(?:读取|修改|修复|检查|扫描|搜索|创建|删除|移动|重构).{0,18}(?:多个|批量|全部|这些|项目|仓库|源码|本地文件|文件夹|目录)|(?:多个|批量|全部|这些).{0,12}(?:源码|本地文件|文件夹|目录).{0,18}(?:读取|修改|修复|检查|扫描|搜索|创建|删除|移动|重构)/iu.test(value);
  const commandOperation = /(?:运行|执行|调用|启动).{0,18}(?:CLI|命令|脚本|npm|node|git|PowerShell|终端|测试)/iu.test(value);
  const releaseOperation = /(?:构建|打包|覆盖安装|安装包|正式发布|编译项目|部署).{0,18}(?:验证|测试|执行|完成|生成|安装)?/iu.test(value);
  const toolOperation = /(?:调用|使用|连接|操作).{0,18}(?:工具|插件|MCP|外部应用|浏览器|桌面程序)/iu.test(value);
  const stateInspection = /(?:真实|实际).{0,12}(?:检查|读取|核验).{0,18}(?:磁盘|程序状态|运行日志|进程|文件系统)/iu.test(value);
  const sustainedExecution = /(?:多步|连续).{0,12}(?:执行|操作|验证)|(?:持续|长时间).{0,12}(?:运行|等待).{0,12}(?:完成|结果)/iu.test(value);
  const reason = fileOperation ? "local_files"
    : commandOperation ? "cli_command"
      : releaseOperation ? "build_release"
        : toolOperation ? "tool_call"
          : stateInspection ? "runtime_inspection"
            : sustainedExecution ? "multi_step"
              : "";
  return {
    recommended: Boolean(reason),
    reason: reason || "chat_sufficient",
    message: reason ? "这个任务需要本地文件、工具调用或多步骤执行，当前 Chat 配置无法完成；请选择可用的 Agent 配置。" : "",
  };
};
