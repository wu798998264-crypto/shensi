export const recoverInterruptedLongFormState = (state) => {
  const jobs = new Map((state?.longFormJobs ?? []).map((job) => [job.id, job]));
  let recovered = 0;
  const recoverMessages = (messages = []) => {
    for (const message of messages) {
      if (!message.pending && message.execution?.status !== "running") continue;
      // Agent starts/runs have a separate authoritative lifecycle supplied by
      // CodexAgentProvider (pendingStarts, activeRuns and recentRuns). Converting
      // them here destroys the source-message link before the provider can
      // reattach or terminate the task after a page refresh.
      if (message.execution?.strength === "agent") continue;
      // Media generation jobs are durable server-side tasks. Keep their local
      // running state until the generation-job recovery pass reconciles the
      // authoritative provider status; treating a page refresh as a failure can
      // invite a duplicate paid submission while the original task is still
      // running.
      if (String(message.execution?.generationJobId || "").trim()) continue;
      const job = jobs.get(message.execution?.jobId);
      if (job && ["planning", "writing", "final_audit"].includes(job.status)) {
        const requestId = String(message.execution?.requestId || job.currentRequestId || "").trim();
        message.pending = false;
        job.status = "paused";
        job.stopRequested = false;
        job.currentRequestId = null;
        job.error = "页面刷新或本地服务重启后已从最近检查点暂停";
        message.content = "长篇任务因页面刷新或本地服务重启而暂停，已完成章节和检查点仍然保留，可继续执行。";
        message.execution = {
          ...(message.execution ?? {}),
          requestId: null,
          completedRequestId: requestId,
          status: "paused",
          executionStatus: "terminal",
          progressPercent: 100,
          result: "已恢复到最近检查点，等待继续",
          retryRequired: true,
          recoveryPending: false,
        };
      } else if (job && ["failed", "cancelled"].includes(job.status)) {
        // A durable long-form checkpoint already records the failure. Do not
        // turn its old request id back into a live recovery task on startup.
        const requestId = String(message.execution?.requestId || job.currentRequestId || "").trim();
        job.currentRequestId = null;
        message.pending = false;
        message.content = String(message.content || message.streamText || "").trim()
          || `长篇任务已${job.status === "cancelled" ? "取消" : "失败"}；已完成检查点仍保留，可从断点重试。`;
        message.execution = {
          ...(message.execution ?? {}),
          requestId: null,
          completedRequestId: requestId,
          status: job.status === "cancelled" ? "cancelled" : "failed",
          executionStatus: "terminal",
          progressPercent: 100,
          result: job.status === "cancelled" ? "长篇任务已取消，检查点仍保留" : "长篇任务失败，检查点仍保留，可从断点重试",
          retryRequired: true,
          recoveryPending: false,
        };
      } else if (job && ["done", "complete", "completed"].includes(job.status)) {
        // A completed checkpoint is also terminal even if the UI was closed
        // before it could replace its pending message.
        const requestId = String(message.execution?.requestId || job.currentRequestId || "").trim();
        job.currentRequestId = null;
        message.pending = false;
        message.execution = {
          ...(message.execution ?? {}),
          requestId: null,
          completedRequestId: requestId,
          status: "complete",
          executionStatus: "terminal",
          progressPercent: 100,
          result: "长篇任务已完成，所有已确认检查点均已保留",
          retryRequired: false,
          recoveryPending: false,
        };
      } else {
        const requestId = String(message.execution?.requestId || "").trim();
        if (requestId) {
          message.pending = true;
          message.content = String(message.content || message.streamText || "").trim();
          message.execution = {
            ...(message.execution ?? {}),
            requestId,
            status: "recovery_pending",
            result: "正在核对页面关闭前的正文任务",
            retryRequired: false,
            recoveryPending: true,
          };
        } else {
          message.pending = false;
          message.content = String(message.content || message.streamText || "").trim()
            || "生成连接在页面关闭期间中断，原请求和引用信息均已保留，请重新生成。";
          message.execution = {
            ...(message.execution ?? {}),
            requestId: null,
            status: "retry_required",
            progressPercent: 100,
            result: "连接中断，需重新生成",
            retryRequired: true,
          };
        }
      }
      recovered += 1;
    }
  };
  recoverMessages(state?.messages);
  for (const conversation of state?.conversations ?? []) recoverMessages(conversation.messages);
  return recovered;
};
