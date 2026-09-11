const clean = (value) => String(value ?? "").trim();
const normalizedCode = (value) => clean(value).toUpperCase();
const legacyAuthRequiredMessage = (value) => /(?:authsdk\s*:\s*not logged in|未检测到(?:有效)?登录态|请先执行\s*dreamina\s+login|dreamina profile[^\r\n]*is not signed in)/iu.test(clean(value));

const ACCOUNT_VERIFICATION_CODES = new Set([
  "DREAMINA_AUTH_REQUIRED",
  "DREAMINA_PROFILE_UNVERIFIED",
  "DREAMINA_ACCOUNT_ID_MISSING",
  "DREAMINA_ACCOUNT_MISMATCH",
  "DREAMINA_ACCOUNT_DUPLICATE",
]);

const LEGACY_UNSTRUCTURED_CODES = new Set([
  "",
  "CLI_PROCESS_FAILED",
  "DRIVER_EXIT_FAILED",
  "PROVIDER_FAILED",
]);

const diagnosis = ({ category, title, cause, resolution, requiresAccountVerification = false, retryable = false }) => ({
  category,
  title,
  cause,
  resolution,
  requiresAccountVerification,
  retryable,
});

export const dreaminaFailureDiagnosis = ({
  code = "",
  message = "",
  providerTaskId = "",
  submissionState = "",
} = {}) => {
  const errorCode = normalizedCode(code);
  const raw = clean(message);
  const providerTaskCreated = Boolean(clean(providerTaskId));
  const submitted = providerTaskCreated || clean(submissionState).toLowerCase() === "submitted";
  const referenceUploadTimedOut = /(?:Action=)?ApplyImageUpload/i.test(raw)
    && /context deadline exceeded|Client\.Timeout exceeded|i\/o timeout|TLS handshake timeout|(?:request|connection|operation) (?:timed out|timeout)|connection (?:reset by peer|refused)|socket hang up|unexpected EOF|temporary failure|no such host/i.test(raw);

  let resolvedCode = errorCode;
  if (ACCOUNT_VERIFICATION_CODES.has(errorCode)) {
    return {
      code: errorCode,
      raw,
      providerTaskCreated,
      ...diagnosis({
        category: "account_verification_required",
        title: "即梦账号授权或身份核验失效",
        cause: errorCode === "DREAMINA_ACCOUNT_MISMATCH"
          ? "当前配置读到的真实即梦账号与已绑定账号不一致，系统已阻止继续操作以避免扣错账号。"
          : errorCode === "DREAMINA_ACCOUNT_DUPLICATE"
            ? "当前账号已经绑定到另一项即梦配置，无法作为独立配置重复使用。"
            : errorCode === "DREAMINA_PROFILE_UNVERIFIED" || errorCode === "DREAMINA_ACCOUNT_ID_MISSING"
              ? "当前即梦配置没有取得可验证的独立账号身份，系统无法确认费用会扣到哪个账号。"
              : "神思已尝试使用当前配置保存的登录状态恢复会话，但即梦仍明确返回未登录。",
        resolution: submitted
          ? "核验当前任务原来使用的即梦配置，然后续接原厂商任务；不要重新提交，以免重复扣费。"
          : "核验当前即梦配置；核验成功并保存账号身份后，再重新提交本次生成。",
        requiresAccountVerification: true,
      }),
    };
  }

  if (errorCode === "DREAMINA_PROVIDER_SESSION_EXPIRED") {
    return {
      code: errorCode,
      raw,
      providerTaskCreated,
      ...diagnosis({
        category: "provider_task_session_verification_required",
        title: "即梦厂商任务会话失效，需要核验原配置",
        cause: "任务已经提交给即梦并保留了厂商任务 ID，但当前配置无法继续查询或下载原任务结果。",
        resolution: "核验当前任务原来使用的即梦配置；核验成功后只续接原厂商任务，不会重新提交或重复扣费。",
        requiresAccountVerification: true,
      }),
    };
  }

  // Older jobs did not persist a stable code. Only those records may use the
  // provider text as a compatibility signal; a real semantic code always wins.
  if (LEGACY_UNSTRUCTURED_CODES.has(errorCode) && legacyAuthRequiredMessage(raw)) {
    resolvedCode = providerTaskCreated ? "DREAMINA_PROVIDER_SESSION_EXPIRED" : "DREAMINA_AUTH_REQUIRED";
    return dreaminaFailureDiagnosis({
      code: resolvedCode,
      message: raw,
      providerTaskId,
      submissionState,
    });
  }

  const known = {
    DREAMINA_PROFILE_REQUIRED: diagnosis({
      category: "profile_selection_required",
      title: "未选择即梦账号配置",
      cause: "当前连接没有携带明确的即梦账号配置，系统已阻止借用其他账号提交任务。",
      resolution: "重新选择一个已绑定真实账号的即梦图片或视频配置后再生成；不需要重新核验其他配置。",
    }),
    DREAMINA_PROFILE_ID_INVALID: diagnosis({
      category: "profile_selection_invalid",
      title: "即梦账号配置无效",
      cause: "当前连接保存的即梦账号配置编号格式无效，系统无法安全定位对应凭据。",
      resolution: "重新选择或保存当前即梦配置；不要核验其他账号，也不要继续使用这条无效连接。",
    }),
    DREAMINA_PROFILE_ID_MISMATCH: diagnosis({
      category: "profile_routing_mismatch",
      title: "即梦配置路由不一致",
      cause: "CLI 回执中的配置编号与本次明确选择的配置不同，系统已阻止继续处理以避免串号。",
      resolution: "保持当前配置不变并重新检查本地运行时；不要核验其他账号，也不要重复提交收费任务。",
    }),
    DREAMINA_INSUFFICIENT_CREDIT: diagnosis({
      category: "insufficient_credit",
      title: "即梦积分不足",
      cause: "当前配置的可用积分不足，收费生成任务未开始。",
      resolution: "刷新积分；如果仍不足，请充值、降低生成参数或切换到积分充足的即梦配置。",
    }),
    DREAMINA_CONCURRENCY_LIMIT: diagnosis({
      category: "provider_concurrency_limit",
      title: "即梦并发名额已满",
      cause: "当前真实账号正在执行的即梦任务数达到厂商上限。",
      resolution: "等待同一账号的运行中任务结束后重试；其他真实账号绑定的配置不受影响。",
      retryable: true,
    }),
    DREAMINA_PROFILE_BROKER_BUSY: diagnosis({
      category: "local_credential_slot_busy",
      title: "即梦凭证槽暂时占用",
      cause: "另一条即梦命令正在使用 Windows 凭证槽，本任务尚未提交给厂商。",
      resolution: "等待软件自动重试；如果长时间不恢复，可终止占用中的旧任务后重新检查。无需重新核验账号。",
      retryable: true,
    }),
    DREAMINA_TASK_RESOURCE_UNVERIFIED: diagnosis({
      category: "task_resource_unverified",
      title: "即梦任务资源接口尚未核验",
      cause: "账号或积分接口可能可读，但生成任务列表没有返回可验证响应，因此不能证明当前配置能够提交和找回结果。",
      resolution: "保持当前配置并重新检查；神思会在产生费用前暂停提交。只有任务资源接口核验通过后才会显示连接成功。",
      retryable: true,
    }),
    DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED: diagnosis({
      category: "auth_refresh_transport_failed",
      title: "即梦登录刷新链路暂时不可用",
      cause: "刷新保存的即梦登录状态时发生网络、进程或本地通信故障，无法证明账号已经掉线。",
      resolution: "检查网络和本地服务后等待自动重试；不要因为这条错误重新核验账号。",
      retryable: true,
    }),
    DREAMINA_GENERATION_SESSION_REJECTED: diagnosis({
      category: "submission_outcome_unknown",
      title: "即梦视频生成会话被拒绝，提交结果待核对",
      cause: "账号与任务列表预检已经通过，但真实视频生成命令没有返回任务编号，并在生成阶段报告会话异常；这不能证明账号核验失效，也不能证明厂商没有创建任务。",
      resolution: "神思将保留原配置、提示词和幂等记录，只读核对厂商任务列表且不会重复提交。需要停止占用时，请在占用任务列表手动终止；无需重复核验账号。",
      retryable: true,
    }),
    DREAMINA_PROVIDER_TASK_AUTH_FAILURE: diagnosis({
      category: "provider_task_internal_failure",
      title: "即梦厂商任务内部授权处理失败",
      cause: "厂商已经返回真实任务编号，但该任务内部的资源处理阶段报告 authsdk 异常。这是厂商任务故障，不代表当前保存的账号身份失效。",
      resolution: "保留并核对原厂商任务编号；不得重新提交同一任务。若厂商最终明确失败，可从失败卡片重新生成，无需先重复核验账号。",
      retryable: true,
    }),
    DREAMINA_CREDIT_QUERY_TIMEOUT: diagnosis({
      category: "control_plane_timeout",
      title: "即梦积分查询超时",
      cause: "即梦账号状态或积分接口暂时没有响应，不能据此判断账号失效。",
      resolution: "稍后刷新积分或重试生成；如果已保存独立账号身份，神思会按安全策略继续处理。无需重新核验。",
      retryable: true,
    }),
    DREAMINA_CONTROL_PLANE_TRANSIENT: diagnosis({
      category: "control_plane_transient",
      title: "即梦账号状态服务暂时不可用",
      cause: "即梦控制面发生临时网络或服务故障，当前无法读取账号状态。",
      resolution: "保持当前配置并稍后重试；这不是账号未核验，不要重新绑定账号。",
      retryable: true,
    }),
    DREAMINA_QUERY_TRANSIENT: diagnosis({
      category: "provider_query_transient",
      title: "即梦任务查询暂时失败",
      cause: "厂商状态查询链路暂时不可用，原厂商任务和任务编号仍然保留。",
      resolution: "等待神思自动续查原任务；不要重新提交，也不需要重新核验账号。",
      retryable: true,
    }),
    DREAMINA_REFERENCE_UPLOAD_NO_TASK: diagnosis({
      category: "reference_upload_failed",
      title: referenceUploadTimedOut ? "即梦参考媒体上传链路超时" : "即梦参考媒体上传失败",
      cause: referenceUploadTimedOut
        ? "即梦的 ApplyImageUpload 上传授权接口在创建视频任务前超时，系统确认没有创建收费任务。"
        : "参考图片、视频或音频未成功上传，系统确认没有创建收费任务。",
      resolution: referenceUploadTimedOut
        ? "检查本机网络或代理到 imagex.bytedanceapi.com 的连接后重试；无需重新核验账号，也不会续接或重复提交旧任务。"
        : "检查参考文件是否存在、可读取且格式受支持，移除异常参考后重试。",
      retryable: true,
    }),
    DREAMINA_REFERENCE_INVALID: diagnosis({
      category: "reference_invalid",
      title: "即梦参考媒体无效",
      cause: "参考文件的类型、路径、数量或内容不符合当前即梦生成模式要求。",
      resolution: "检查参考文件是否完整，并按当前图片或视频模式允许的数量和格式重新选择。",
    }),
    DREAMINA_SUBMISSION_UNCERTAIN: diagnosis({
      category: "submission_outcome_unknown",
      title: "即梦提交结果暂时无法确认",
      cause: "提交期间连接中断，本地未取得厂商任务编号，无法证明任务是否已创建。",
      resolution: "先使用自动找回或在厂商任务列表核对；确认前不要重新提交，避免重复扣费。",
      retryable: true,
    }),
    DREAMINA_SUBMISSION_NOT_VISIBLE: diagnosis({
      category: "submission_reconciliation_pending",
      title: "即梦任务记录尚未可见",
      cause: "提交记录正在同步，当前即梦任务列表暂时查不到对应任务。",
      resolution: "等待神思继续自动找回；不要重新提交或重新核验账号。",
      retryable: true,
    }),
    DREAMINA_SUBMISSION_RECONCILIATION_LEASE_EXPIRED: diagnosis({
      category: "submission_reconciliation_expired",
      title: "即梦自动找回已达到时限",
      cause: "系统在安全时限内仍无法确认原提交是否创建厂商任务。",
      resolution: "人工核对即梦任务列表后，再选择继续找回或确认重新生成。不要直接重复提交。",
    }),
    DREAMINA_RESULT_PENDING: diagnosis({
      category: "provider_result_pending",
      title: "即梦结果文件尚未就绪",
      cause: "厂商任务已完成，但下载文件暂时还不可读取。",
      resolution: "神思会在安全时限内继续下载原任务；超过时限后可点击“找回结果”再次取回，不要重新生成。",
      retryable: true,
    }),
    DREAMINA_UNKNOWN_STATUS: diagnosis({
      category: "unknown_provider_status",
      title: "即梦返回了未知任务状态",
      cause: "当前 CLI 无法识别厂商返回的任务状态，不能安全判定成功或失败。",
      resolution: "保留任务编号并重新检查；如持续出现，请记录错误码、原始报错和任务编号用于适配新状态。",
    }),
  };
  const selected = known[errorCode]
    || (/CREDITPREDEDUCTNOTENOUGH|积分为\s*0|余额不足|积分不足/i.test(`${errorCode} ${raw}`)
      ? known.DREAMINA_INSUFFICIENT_CREDIT
      : diagnosis({
        category: "provider_failure",
        title: "即梦生成失败",
        cause: "即梦返回了当前版本尚未归类的生成故障。",
        resolution: "保留错误代码、原始报错和任务编号后重试；不要先执行账号核验，除非错误代码明确为 DREAMINA_AUTH_REQUIRED。",
        retryable: true,
      }));
  return { code: resolvedCode || "DREAMINA_UNCLASSIFIED_FAILURE", raw, providerTaskCreated, ...selected };
};

export const dreaminaFailureRequiresAccountVerification = (input = {}) => (
  dreaminaFailureDiagnosis(input).requiresAccountVerification === true
);

export const dreaminaFailureDisplayText = (input = {}) => {
  const result = dreaminaFailureDiagnosis(input);
  const detail = result.raw && result.raw !== result.cause ? ` 原始报错：${result.raw}` : "";
  return `错误代码：${result.code}。原因：${result.cause} 处理方法：${result.resolution}${detail}`;
};
