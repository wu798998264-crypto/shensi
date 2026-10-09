// A terminal provider failure is not a submission waiting to be recovered.
// Neither state permits another paid submission under the same recovery key.
export const openAiImageRecoveryFailurePatch = (error = {}) => ({
  state: error.submissionOutcomeKnown === true ? "failed" : "submission_unknown",
  failedAt: new Date().toISOString(),
  failure: {
    message: String(error.message || error).slice(0, 2_000),
    code: String(error.code || "OPENAI_IMAGE_CLI_FAILED"),
    providerErrorCode: String(error.providerErrorCode || error.code || ""),
    submissionOutcomeKnown: error.submissionOutcomeKnown === true,
  },
});

export const openAiImageRecoveryFailure = (record = {}) => (
  record.state === "failed" && record.failure?.submissionOutcomeKnown === true
    ? Object.assign(new Error(record.failure.message || "OpenAI 图片生成失败"), record.failure)
    : null
);
