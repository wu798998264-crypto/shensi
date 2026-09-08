import { assertDreaminaAccountIdentity } from "./dreamina-account-identity.mjs";

const clean = (value) => String(value ?? "").trim();
const CREDIT_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

const requiredProfileId = (value = process.env.SHENSI_DREAMINA_PROFILE_ID) => {
  const profileId = clean(value);
  if (profileId) return profileId;
  const error = new Error("当前即梦运行环境缺少明确账号配置");
  error.code = "DREAMINA_PROFILE_REQUIRED";
  throw error;
};

const nestedValue = (value, keys = []) => {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && clean(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = nestedValue(child, keys);
    if (found !== "") return found;
  }
  return "";
};

export const dreaminaAvailableCredit = (payload = {}) => {
  const value = nestedValue(payload, ["total_credit", "totalCredit", "credit", "credits"]);
  if (value === "" || value === null || value === undefined) return null;
  const credit = Number(value);
  return Number.isFinite(credit) && credit >= 0 ? credit : null;
};

export const dreaminaSavedPositiveCreditEvidence = ({
  environment = process.env,
  nowMs = Date.now(),
} = {}) => {
  const creditText = clean(environment.SHENSI_DREAMINA_SAVED_CREDIT);
  const credit = Number(creditText);
  const observedAt = clean(environment.SHENSI_DREAMINA_SAVED_CREDIT_AT);
  const observedAtMs = Date.parse(observedAt);
  if (!creditText || !Number.isFinite(credit) || credit <= 0) return null;
  if (!observedAt || !Number.isFinite(observedAtMs)) return null;
  const ageMs = nowMs - observedAtMs;
  if (ageMs < 0 || ageMs > CREDIT_EVIDENCE_MAX_AGE_MS) return null;
  return { credit, observedAt, ageMs };
};

const liveZeroConflictsWithSavedPositive = (account = {}) => (
  account?.controlPlaneDeferred !== true
  && dreaminaAvailableCredit(account?.credit || account) === 0
  && dreaminaSavedPositiveCreditEvidence()
);

// A confirmed zero balance is different from a transient control-plane failure:
// reject before the paid submit call, while still allowing deferred checks through.
export const assertDreaminaGenerationCredit = (account = {}) => {
  if (account?.controlPlaneDeferred === true) return null;
  const credit = dreaminaAvailableCredit(account?.credit || account);
  if (credit === 0 && account?.creditSourceConflict === true) return null;
  if (credit !== null && credit <= 0) {
    const error = new Error("即梦当前配置积分为 0，未提交生成任务。请充值或切换积分充足的配置。");
    error.code = "DREAMINA_INSUFFICIENT_CREDIT";
    error.submissionOutcomeKnown = true;
    throw error;
  }
  return credit;
};

export const dreaminaControlPlaneFailureIsTransient = (error) => {
  const code = clean(error?.code || error?.providerErrorCode).toUpperCase();
  const message = clean(error?.message || error);
  return /^(?:DREAMINA_(?:PROFILE_BROKER_BUSY|CREDIT_QUERY_TIMEOUT|CONTROL_PLANE_TRANSIENT|AUTH_REFRESH_TRANSPORT_FAILED)|DRIVER_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)$/u.test(code)
    || /(?:user_credit|list_task|query_result|状态|积分|命令).{0,80}(?:超时|未响应|timeout|timed out|temporar|network|socket|busy|繁忙)/iu.test(message);
};

export const cachedDreaminaAccountIdentity = () => {
  const profileId = clean(process.env.SHENSI_DREAMINA_PROFILE_ID);
  const expectedUserId = clean(process.env.SHENSI_DREAMINA_EXPECTED_USER_ID);
  const credentialFingerprint = clean(process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT);
  if (!profileId || !expectedUserId || !credentialFingerprint || credentialFingerprint === "unverified") return null;
  return {
    profileId,
    userId: expectedUserId,
    expectedUserId,
    credit: null,
    vipLevel: "",
    credentialFingerprint,
    verificationSource: "cached_verified_profile",
  };
};

export const verifiedDreaminaAccountWithControlPlaneFallback = async (readCredit) => {
  try {
    const credit = await readCredit();
    return {
      credit,
      identity: {
        ...assertDreaminaAccountIdentity(credit),
        credentialFingerprint: clean(process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT),
        verificationSource: "live_user_credit",
      },
      controlPlaneDeferred: false,
    };
  } catch (error) {
    // Some versions of the official CLI return the balance payload without
    // `user_id` even though the isolated credential is still the same,
    // already-verified profile. Treat that response like a control-plane
    // read gap only when a durable local identity exists. An unbound profile
    // still fails closed and must complete browser verification first.
    const identity = (dreaminaControlPlaneFailureIsTransient(error)
      || String(error?.code || error?.providerErrorCode || "").toUpperCase() === "DREAMINA_ACCOUNT_ID_MISSING")
      ? cachedDreaminaAccountIdentity()
      : null;
    if (!identity) throw error;
    return {
      credit: {},
      identity,
      controlPlaneDeferred: true,
      controlPlaneWarning: clean(error?.message || error),
    };
  }
};

// A single zero from user_credit is not conclusive when the same verified
// profile has a recent, positive durable balance. Re-read the live endpoint a
// bounded number of times. If every response still conflicts, preserve the
// identity verdict but let the paid generator endpoint make the authoritative
// billing decision instead of fabricating a local "insufficient credit" error.
export const verifiedDreaminaAccountForPaidSubmission = async (readCredit, {
  retries = 2,
  retryDelayMs = 800,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
} = {}) => {
  const boundedRetries = Math.max(0, Math.min(3, Number(retries) || 0));
  let account = await verifiedDreaminaAccountWithControlPlaneFallback(readCredit);
  let savedEvidence = liveZeroConflictsWithSavedPositive(account);
  let recheckCount = 0;
  while (savedEvidence && recheckCount < boundedRetries) {
    recheckCount += 1;
    await wait(Math.max(0, Number(retryDelayMs) || 0) * recheckCount);
    account = await verifiedDreaminaAccountWithControlPlaneFallback(readCredit);
    savedEvidence = liveZeroConflictsWithSavedPositive(account);
  }
  if (!savedEvidence) return account;
  return {
    ...account,
    creditSourceConflict: true,
    creditConflictCode: "DREAMINA_CREDIT_SOURCE_CONFLICT",
    creditRecheckCount: recheckCount,
    savedCreditEvidence: {
      credit: savedEvidence.credit,
      observedAt: savedEvidence.observedAt,
    },
  };
};

export const dreaminaExecutionReceipt = (identity = null) => {
  const cached = cachedDreaminaAccountIdentity();
  const source = identity || cached || {};
  return {
    profileId: requiredProfileId(source.profileId || process.env.SHENSI_DREAMINA_PROFILE_ID),
    expectedUserId: clean(source.expectedUserId || process.env.SHENSI_DREAMINA_EXPECTED_USER_ID),
    actualUserId: clean(source.userId),
    credentialFingerprint: clean(source.credentialFingerprint || process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT),
    verificationSource: clean(source.verificationSource) || "profile_runtime",
  };
};
