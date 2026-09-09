const redactedInput = (value) => JSON.stringify(value, (key, entry) => (
  /api.?key|password|secret|token|authorization|credential/iu.test(key) ? "[REDACTED]" : entry
)).slice(0, 4_000);

const allowedByAnswer = (response) => {
  const answer = String(response?.answer || response || "").trim().toLowerCase();
  return answer === "allow" || answer.includes("允许本次操作");
};

export const requestAgentCapabilityApproval = async ({
  permissionMode = "shensi_only",
  capability = "受保护能力",
  runner = "Agent",
  requestApproval,
} = {}) => {
  if (permissionMode === "shensi_only") return false;
  if (permissionMode === "full_access") return true;
  if (typeof requestApproval !== "function") {
    throw Object.assign(new Error("操作需确认模式缺少神思审批通道"), { code: "AGENT_APPROVAL_CHANNEL_REQUIRED" });
  }
  const response = await requestApproval({
    question: `${runner} 请求启用${capability}。是否允许本次操作？`,
    options: [{ id: "allow", label: "允许本次操作" }, { id: "deny", label: "拒绝本次操作" }],
    detail: { runner, capability, operation: "network_exfiltration", action: capability },
  });
  return allowedByAnswer(response);
};

export const toolsWithPermissionPrompt = (tools = {}, requestApproval, { runner = "claude_code" } = {}) => {
  if (typeof requestApproval !== "function") return tools;
  const permissionTool = {
    type: "namespace",
    name: "permission",
    description: "将外置运行器的单次受保护操作交给神思用户确认",
    tools: [{
      type: "function",
      name: "prompt",
      description: "仅供运行器权限系统调用；显示本次工具操作并返回允许或拒绝。",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    }],
  };
  return {
    ...tools,
    dynamicTools: [...(tools.dynamicTools || []), permissionTool],
    async invoke(request) {
      if (request.namespace !== "permission" || request.tool !== "prompt") {
        if (typeof tools.invoke !== "function") throw new Error("当前任务未提供此神思工具");
        return tools.invoke(request);
      }
      const input = request.arguments && typeof request.arguments === "object" ? request.arguments : {};
      const toolName = String(input.tool_name || input.toolName || input.tool || "受保护工具").slice(0, 200);
      const toolInput = input.input && typeof input.input === "object" ? input.input
        : input.tool_input && typeof input.tool_input === "object" ? input.tool_input
          : input;
      const compactInput = redactedInput(toolInput);
      const response = await requestApproval({
        question: `Agent 请求使用 ${toolName}：${compactInput}。是否允许本次操作？`,
        options: [{ id: "allow", label: "允许本次操作" }, { id: "deny", label: "拒绝本次操作" }],
        detail: { runner, toolName, input: compactInput },
      });
      const result = allowedByAnswer(response)
        ? { behavior: "allow", updatedInput: toolInput }
        : { behavior: "deny", message: "用户拒绝了本次操作" };
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
    },
  };
};
