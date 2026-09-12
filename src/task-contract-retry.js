const text = (value = "") => String(value ?? "").trim();
const clone = (value) => value == null ? value : structuredClone(value);

const FORMAL_TASK_RETRY_INSTRUCTION = /^(?:(?:请)?(?:我)?(?:按|按照)?(?:当前|原)?(?:任务)?合同(?:原样)?(?:重新)?(?:重试|执行|生成)|(?:请)?(?:重试|再试(?:一次|一下)?|重新执行|按上条执行)(?:本条|上一条|当前)?(?:正式)?任务?)[。！!，,\s]*$/u;

const messageTaskContract = (message = {}) => (
  message.creativeTask?.taskContract
  || message.taskRoute?.taskContract
  || message.creativeMutationPlan?.taskContract
  || null
);

export const isTaskContractRetryInstruction = (instruction = "") => FORMAL_TASK_RETRY_INSTRUCTION.test(text(instruction));

export const resolveTaskContractRetryContext = ({ instruction = "", messages = [] } = {}) => {
  if (!isTaskContractRetryInstruction(instruction)) return null;
  const sourceMessage = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => {
    if (message?.role !== "user") return false;
    const contract = messageTaskContract(message);
    return Array.isArray(contract?.deliverables) && contract.deliverables.some((item) => item?.required !== false);
  });
  if (!sourceMessage) return null;
  const prompt = text(sourceMessage.modelContent || sourceMessage.content);
  if (!prompt) return null;
  return {
    sourceMessage,
    taskContract: clone(messageTaskContract(sourceMessage)),
    prompt,
    executionSurface: "agent",
  };
};
