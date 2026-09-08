const MODEL_STATUS = /(?:当前|现在|正在使用|已连接|实际使用|运行中).{0,18}(?:模型|model|连接)|(?:模型|model).{0,18}(?:是什么|是哪|哪个|版本|5[.．-]?\d|sol)/i;
const SOFTWARE_DIAGNOSTIC = /(?:检查|诊断|审计|排查|评估).{0,24}(?:神思|软件|本地版|桌面端|运行).{0,24}(?:架构|框架|代码|漏洞|隐患|运行|稳定)|(?:架构|代码|运行机制).{0,18}(?:检查|诊断|漏洞|隐患|稳定)/i;
const SELF_MODIFICATION = /(?:能否|可以|会不会|是否).{0,16}(?:自我优化|修改自己|修改软件|直接修复|(?:修改|优化).{0,8}(?:自己|软件))|(?:自我优化|修改自己|直接修复|(?:修改|优化).{0,8}(?:自己|软件)).{0,12}(?:吗|么|？|\?)/i;
const QUEUE_BEHAVIOR = /(?:为什么|为何|怎么|如何|当前).{0,28}(?:排队|队列|同时执行|并发执行)|(?:后发|连续发送|下一条|多条指令).{0,24}(?:排队|补充|同时执行|队列)/i;

export const runtimeEvidenceQuestionKind = (value = "") => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (MODEL_STATUS.test(text)) return "model_status";
  if (SOFTWARE_DIAGNOSTIC.test(text)) return "software_diagnostic";
  if (SELF_MODIFICATION.test(text)) return "self_modification";
  if (QUEUE_BEHAVIOR.test(text)) return "queue_behavior";
  return "";
};

export const runtimeEvidenceReply = ({ kind = "", activeProfile = null, connectionAvailable = false } = {}) => {
  if (kind === "model_status") {
    if (!activeProfile) return "当前没有配置文本模型连接。此结论来自本机运行配置，不是模型猜测。";
    const adapterLabel = activeProfile.adapter === "cli" ? "CLI" : "API";
    return `当前文本连接配置为：${activeProfile.provider || "未标注厂商"} · ${activeProfile.model || "未选择模型"} · ${adapterLabel}${activeProfile.reasoningEffort ? ` · 推理档位 ${activeProfile.reasoningEffort}` : ""}。连接状态：${connectionAvailable ? "已通过当前可用性检查" : "尚未通过真实可用性检查"}。这是本机设置的实际值；仅凭名称不能把其他模型推断成 GPT-5.6 Sol。`;
  }
  if (kind === "software_diagnostic") {
    return "这是一项需要读取本地代码、运行测试并核对实际配置的工程诊断，普通 GPT CLI 对话没有这些证据，不能可靠地下结论。请切换到 Codex Agent，选择神思项目目录后重新发送；届时读取可自动进行，修改和命令会先请求授权。";
  }
  if (kind === "self_modification") {
    return "普通 GPT CLI 对话可以分析问题和提出方案，但不能据此宣称已经修改软件。只有切换到 Codex Agent、明确选择项目目录，并对文件修改与命令执行逐项授权后，神思才能真实读取代码、展示 diff、运行测试并应用改动。";
  }
  if (kind === "queue_behavior") {
    return "当前对话采用单任务串行队列：正在编译上下文、调用文本模型或等待图片/视频后台任务结束时，新指令先进入队列；排队项可以修改、删除，适合的纯文字补充可并入当前任务。只有当前任务进入完成、失败、取消或中断终态后，下一条才会自动开始。不同的厂商媒体排队属于后台 Job 队列，会单独显示进度，不能替代对话指令队列。";
  }
  return "";
};
