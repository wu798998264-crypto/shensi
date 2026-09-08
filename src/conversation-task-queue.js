const ACTIVE_TASK_STATUSES = new Set([
  "queued",
  "submitting",
  "running",
  "polling",
  "downloading",
  "verifying",
  "applying",
  "cancel_requested",
]);

export const CONVERSATION_TASK_TERMINAL_STATUSES = Object.freeze([
  "complete",
  "completed",
  "done",
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "retry_required",
  "draft",
  "paused",
  "blocked",
  "hard_blocked",
  "soft_warning",
  "ready_to_land",
  "waiting_input",
  "awaiting_action",
  "awaiting_adoption",
  "awaiting_confirmation",
  "awaiting_candidate_confirmation",
  "awaiting_landing_receipt",
  "waiting_credentials",
  "waiting_storage",
  "reconciliation_required",
]);

const TERMINAL_TASK_STATUSES = new Set(CONVERSATION_TASK_TERMINAL_STATUSES);

export const conversationCompletionStatus = (status = "") => {
  const normalized = String(status || "").trim();
  return TERMINAL_TASK_STATUSES.has(normalized) ? normalized : "complete";
};

export const conversationTaskMessageIsRunning = (message = null) => {
  if (message?.role !== "assistant") return false;
  const status = String(message.execution?.status || message.execution?.mediaJobStatus || "");
  if (TERMINAL_TASK_STATUSES.has(status) || message.execution?.executionStatus === "terminal") return false;
  // A completed reply can retain a provider's last active status even after
  // the UI has recorded its terminal timestamp. That stale status must not
  // keep every later instruction in the conversation queue forever.
  if (message.execution?.endedAt || message.execution?.completedAt) return false;
  return message.pending === true || ACTIVE_TASK_STATUSES.has(status);
};

const conversationTaskIdentityKeys = (message = {}) => new Set([
  message.execution?.requestId,
  message.execution?.generationJobId,
  message.execution?.agentTurnId,
  message.execution?.sourceMessageId,
].map((value) => String(value || "").trim()).filter(Boolean));

export const conversationTaskIsRunning = (messages = []) => (messages ?? []).some((message, index, items) => {
  if (!conversationTaskMessageIsRunning(message)) return false;
  const identityKeys = conversationTaskIdentityKeys(message);
  if (!identityKeys.size) return true;
  const supersededByTerminalReply = items.slice(index + 1).some((candidate) => {
    if (candidate?.role !== "assistant" || conversationTaskMessageIsRunning(candidate)) return false;
    const candidateKeys = conversationTaskIdentityKeys(candidate);
    return [...identityKeys].some((key) => candidateKeys.has(key));
  });
  return !supersededByTerminalReply;
});

export const conversationImmediateInstructionBlocksDispatch = ({
  conversationId = "",
  instructions = [],
  instructionId = "",
} = {}) => {
  const targetConversationId = String(conversationId || "");
  if (!targetConversationId) return false;
  const pending = (instructions ?? []).filter((instruction) => (
    String(instruction?.conversationId || "") === targetConversationId
  ));
  if (!pending.length) return false;
  const currentInstructionId = String(instructionId || "");
  if (!currentInstructionId) return true;
  const currentIndex = pending.findIndex((instruction) => String(instruction?.id || "") === currentInstructionId);
  // Map insertion order is the acceptance order. Only an earlier accepted
  // instruction blocks this one; later instructions must queue behind it.
  return currentIndex < 0 || currentIndex > 0;
};

export const repairConversationTaskMessages = (messages = []) => {
  let repaired = 0;
  for (let index = 0; index < (messages ?? []).length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.pending !== true) continue;
    if (conversationTaskIsRunning(messages.slice(index))) continue;
    message.pending = false;
    const execution = message.execution ??= {};
    const status = String(execution.status || execution.mediaJobStatus || "");
    if (ACTIVE_TASK_STATUSES.has(status) && (execution.endedAt || execution.completedAt)) {
      execution.status = "complete";
    }
    repaired += 1;
  }
  return repaired;
};

export const conversationCanAcceptSupplement = ({
  messages = [],
  preparations = [],
  preparingSourceMessageIds = [],
  immediateInstructionActive = false,
} = {}) => {
  const supplementableMessages = (messages ?? []).filter((message) => (
    !["cancel_requested", "interrupting"].includes(String(message?.execution?.status || ""))
  ));
  if (conversationTaskIsRunning(supplementableMessages)) return true;
  const sourceIds = preparingSourceMessageIds instanceof Set
    ? preparingSourceMessageIds
    : new Set(preparingSourceMessageIds ?? []);
  const livePreparation = (preparations ?? []).some((preparation) => {
    if (!preparation || preparation.cancelled || preparation.finalized) return false;
    const pendingMessageId = String(preparation.pendingMessageId || "");
    const sourceMessageId = String(preparation.sourceMessageId || "");
    return (pendingMessageId && (messages ?? []).some((message) => (
      String(message?.id || "") === pendingMessageId && conversationTaskMessageIsRunning(message)
    ))) || (sourceMessageId && sourceIds.has(sourceMessageId));
  });
  return livePreparation || immediateInstructionActive === true;
};

export const createConversationDispatchGate = () => {
  const active = new Map();
  return {
    claim(conversationId, token) {
      const id = String(conversationId || "");
      if (!id || active.has(id)) return false;
      active.set(id, token);
      return true;
    },
    release(conversationId, token) {
      const id = String(conversationId || "");
      if (!id || active.get(id) !== token) return false;
      active.delete(id);
      return true;
    },
    has(conversationId) {
      return active.has(String(conversationId || ""));
    },
  };
};

export const createConversationPreparationRegistry = () => {
  const active = new Map();
  return {
    begin(record = {}) {
      const sourceMessageId = String(record.sourceMessageId || "");
      if (!sourceMessageId) throw new Error("任务准备记录缺少来源消息");
      const normalized = {
        ...record,
        sourceMessageId,
        conversationId: String(record.conversationId || ""),
        pendingMessageId: String(record.pendingMessageId || ""),
        dispatchToken: String(record.dispatchToken || ""),
        startedAt: Math.max(1, Number(record.startedAt) || Date.now()),
        cancelled: false,
        cancelledAt: 0,
      };
      active.set(sourceMessageId, normalized);
      return normalized;
    },
    get(sourceMessageId) {
      return active.get(String(sourceMessageId || "")) ?? null;
    },
    findByPendingMessage(pendingMessageId) {
      const id = String(pendingMessageId || "");
      return [...active.values()].find((record) => record.pendingMessageId === id) ?? null;
    },
    cancel(sourceMessageId, cancelledAt = Date.now()) {
      const record = active.get(String(sourceMessageId || ""));
      if (!record) return null;
      record.cancelled = true;
      record.cancelledAt = Math.max(record.startedAt, Number(cancelledAt) || Date.now());
      return record;
    },
    complete(sourceMessageId, expectedRecord = null) {
      const id = String(sourceMessageId || "");
      const record = active.get(id);
      if (!record || (expectedRecord && record !== expectedRecord)) return false;
      active.delete(id);
      return true;
    },
    activeForConversation(conversationId) {
      const id = String(conversationId || "");
      return [...active.values()].filter((record) => record.conversationId === id);
    },
  };
};

export const conversationPreparationCancelledError = (record = {}) => {
  const error = new Error("当前任务已由用户停止");
  error.code = "TASK_CANCELLED";
  error.sourceMessageId = String(record.sourceMessageId || "");
  error.conversationId = String(record.conversationId || "");
  return error;
};

const cloneQueueValue = (value) => {
  if (value === undefined) return undefined;
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
};

const queueReceiptKey = (itemId, leaseId) => `${String(itemId || "")}::${String(leaseId || "")}`;
const rememberQueueAck = (conversation, itemId, leaseId) => {
  conversation.queueAcknowledgements ??= [];
  const key = queueReceiptKey(itemId, leaseId);
  if (!conversation.queueAcknowledgements.includes(key)) conversation.queueAcknowledgements.push(key);
  if (conversation.queueAcknowledgements.length > 200) conversation.queueAcknowledgements.splice(0, conversation.queueAcknowledgements.length - 200);
};

const normalizeQueueItem = (item = {}) => ({
  ...item,
  state: item.state === "dispatching" ? "dispatching" : item.state === "editing" ? "editing" : "queued",
  leaseId: String(item.leaseId || ""),
  claimedAt: Math.max(0, Number(item.claimedAt) || 0),
  attempts: Math.max(0, Number(item.attempts) || 0),
  lastError: String(item.lastError || ""),
});

export const recoverConversationTaskQueue = (conversation, { now = Date.now(), leaseTimeoutMs = 120_000 } = {}) => {
  if (!conversation) return { recoveredIds: [], queuedIds: [] };
  conversation.queue = (Array.isArray(conversation.queue) ? conversation.queue : []).map(normalizeQueueItem);
  const recovered = [];
  const retained = [];
  for (const item of conversation.queue) {
    const expired = item.state === "dispatching"
      && (!item.claimedAt || Math.max(0, Number(now) - item.claimedAt) >= Math.max(1, Number(leaseTimeoutMs) || 120_000));
    if (!expired) {
      retained.push(item);
      continue;
    }
    recovered.push({
      ...item,
      state: "queued",
      leaseId: "",
      claimedAt: 0,
      lastError: "dispatch_lease_expired",
    });
  }
  conversation.queue = [...recovered, ...retained];
  return {
    recoveredIds: recovered.map((item) => item.id),
    queuedIds: conversation.queue.filter((item) => item.state === "queued").map((item) => item.id),
  };
};

export const ackConversationInstruction = ({ conversation, itemId = "", leaseId = "" } = {}) => {
  if (!conversation) return false;
  conversation.queue ??= [];
  const key = queueReceiptKey(itemId, leaseId);
  if ((conversation.queueAcknowledgements ?? []).includes(key)) return true;
  const index = conversation.queue.findIndex((item) => String(item.id || "") === String(itemId || ""));
  if (index < 0) return false;
  const item = normalizeQueueItem(conversation.queue[index]);
  if (item.state !== "dispatching" || item.leaseId !== String(leaseId || "")) return false;
  conversation.queue.splice(index, 1);
  rememberQueueAck(conversation, itemId, leaseId);
  return true;
};

export const conversationQueueItemOwnedByTask = ({ conversation, itemId = "", leaseId = "" } = {}) => {
  const item = conversation?.queue?.find((candidate) => String(candidate.id || "") === String(itemId || ""));
  return Boolean(item && item.state === "dispatching" && item.leaseId === String(leaseId || ""));
};

export const markConversationInstructionAccepted = ({
  conversation,
  itemId = "",
  leaseId = "",
  sourceMessageId = "",
  requestId = "",
  agentTurnId = "",
  acceptedAt = Date.now(),
} = {}) => {
  if (!conversationQueueItemOwnedByTask({ conversation, itemId, leaseId })) return null;
  const item = conversation.queue.find((candidate) => String(candidate.id || "") === String(itemId || ""));
  item.sourceMessageId = String(sourceMessageId || item.sourceMessageId || "");
  item.requestId = String(requestId || item.requestId || "");
  item.agentTurnId = String(agentTurnId || item.agentTurnId || "");
  item.acceptedAt = Math.max(1, Number(acceptedAt) || Date.now());
  return item;
};

const queueItemOwnedByRunningTask = (conversation, item, task = {}) => {
  if (!item || item.state !== "dispatching") return false;
  const taskConversationId = task.conversationId == null ? "" : String(task.conversationId).trim();
  const taskQueueItemId = task.queueItemId == null ? "" : String(task.queueItemId).trim();
  const taskLeaseId = task.leaseId == null ? "" : String(task.leaseId).trim();
  const itemId = item.id == null ? "" : String(item.id).trim();
  const itemLeaseId = item.leaseId == null ? "" : String(item.leaseId).trim();
  if (taskConversationId && taskConversationId !== String(conversation?.id || "").trim()) return false;
  if (taskQueueItemId && taskQueueItemId !== itemId) return false;
  if (taskLeaseId && taskLeaseId !== itemLeaseId) return false;
  // A persisted pending message records the queue item and lease before its
  // provider request is accepted. Those two fields are the strongest
  // ownership proof and remain sufficient when older data lacks the other
  // task identifiers.
  if (taskQueueItemId && taskQueueItemId === itemId
    && (!taskLeaseId || taskLeaseId === itemLeaseId)) return true;
  const taskIds = new Set([
    task.id,
    task.messageId,
    task.sourceMessageId,
    task.requestId,
    task.agentTurnId,
  ].filter((value) => value != null && String(value).trim()).map((value) => String(value).trim()));
  const itemIds = [item.sourceMessageId, item.requestId, item.agentTurnId]
    .filter((value) => value != null && String(value).trim())
    .map((value) => String(value).trim());
  return itemIds.some((id) => taskIds.has(id));
};

export const recoverConversationTaskQueueForStartup = (conversation, { runningTaskIds = [], runningTasks = [], now = Date.now() } = {}) => {
  if (!conversation) return { recoveredIds: [], retainedIds: [] };
  const tasks = [
    ...(runningTasks ?? []).filter((task) => task && typeof task === "object"),
    ...(runningTaskIds ?? []).map((id) => ({ id: String(id || "") })),
  ];
  conversation.queue = (Array.isArray(conversation.queue) ? conversation.queue : []).map(normalizeQueueItem);
  const recovered = [];
  const retained = [];
  for (const item of conversation.queue) {
    if (tasks.some((task) => queueItemOwnedByRunningTask(conversation, item, task))) {
      retained.push(item);
      continue;
    }
    if (item.state === "dispatching") {
      recovered.push({
        ...item,
        state: "queued",
        leaseId: "",
        claimedAt: 0,
        lastError: item.claimedAt && now - item.claimedAt >= 120_000
          ? "dispatch_lease_expired"
          : "dispatch_owner_not_running",
      });
    } else retained.push(item);
  }
  conversation.queue = [...recovered, ...retained];
  return { recoveredIds: recovered.map((item) => item.id), retainedIds: retained.map((item) => item.id) };
};

export const nackConversationInstruction = ({ conversation, itemId = "", leaseId = "", error = "dispatch_failed" } = {}) => {
  if (!conversation) return false;
  conversation.queue ??= [];
  const index = conversation.queue.findIndex((item) => String(item.id || "") === String(itemId || ""));
  if (index < 0) return (conversation.queueAcknowledgements ?? []).includes(queueReceiptKey(itemId, leaseId));
  const item = normalizeQueueItem(conversation.queue[index]);
  if (item.state === "queued" && !item.leaseId) return true;
  if (item.state !== "dispatching" || item.leaseId !== String(leaseId || "")) return false;
  conversation.queue.splice(index, 1);
  conversation.queue.unshift({
    ...item,
    state: "queued",
    leaseId: "",
    claimedAt: 0,
    lastError: String(error || "dispatch_failed"),
  });
  return true;
};

export const requeueEditedConversationInstruction = ({ conversation, itemId = "", content = "", mediaDispatch = null } = {}) => {
  if (!conversation) return null;
  conversation.queue ??= [];
  const item = conversation.queue.find((candidate) => String(candidate.id || "") === String(itemId || ""));
  const nextContent = String(content || "").trim();
  if (!item || !nextContent) return null;
  item.content = nextContent;
  if (item.displayContent) item.displayContent = nextContent;
  item.state = "queued";
  item.leaseId = "";
  item.claimedAt = 0;
  item.lastError = "";
  item.mediaDispatch = cloneQueueValue(mediaDispatch);
  return item;
};

export const enqueueCompositeConversationSteps = ({
  conversation,
  parentInstruction = "",
  baseItem = {},
  steps = [],
  idFor = (index) => `composite-${Date.now()}-${index + 1}`,
} = {}) => {
  if (!conversation || !Array.isArray(steps) || steps.length < 2) return [];
  conversation.queue ??= [];
  const total = steps.length;
  const items = steps.map((step, index) => ({
    ...cloneQueueValue(baseItem),
    id: String(idFor(index, step)),
    content: `【复合任务 ${index + 1}/${total}｜${String(step.label || "能力步骤")}】\n【原始指令】${String(parentInstruction || "").trim()}\n【本步必须实际执行】${String(step.instruction || "").trim()}`,
    compositeParentInstruction: String(parentInstruction || "").trim(),
    compositeStep: cloneQueueValue({ ...step, index: index + 1, total }),
    mediaDispatch: step.kind === "image" || step.kind === "video" ? {
      version: 1,
      kind: "media",
      channel: step.kind,
      reason: `复合任务第 ${index + 1}/${total} 步`,
      plannedBatch: (step.kind === "image" || step.kind === "video") ? cloneQueueValue(step.plannedBatch || []) : [],
    } : null,
    queuedAt: Date.now() + index,
    state: "queued",
    leaseId: "",
    claimedAt: 0,
    attempts: 0,
    lastError: "",
  }));
  conversation.queue.unshift(...items);
  return items;
};

export const dequeueReadyConversationInstruction = ({ conversation, messages = [], dispatching = false, blocked = false, now = Date.now(), leaseId = "" } = {}) => {
  if (!conversation || dispatching || blocked || conversationTaskIsRunning(messages)) return null;
  recoverConversationTaskQueue(conversation, { now });
  const item = conversation.queue.find((candidate) => candidate.state === "queued");
  if (!item) return null;
  item.state = "dispatching";
  item.leaseId = String(leaseId || `lease-${Number(now)}-${Math.random().toString(36).slice(2, 10)}`);
  item.claimedAt = Math.max(1, Number(now) || Date.now());
  item.attempts = Math.max(0, Number(item.attempts) || 0) + 1;
  item.lastError = "";
  return item;
};
