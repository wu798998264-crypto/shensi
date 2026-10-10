// Only retry upload failures when the response contains no task identity.
// Both resolved JSON failures and rejected CLI exits use this same policy.
export const runKnownUnsubmittedVideoUpload = async ({ run, taskId, knownUploadFailure, retries, delay }) => {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await run();
      const text = [result?.stdout, result?.stderr].filter(Boolean).join("\n");
      if (taskId(result) || !knownUploadFailure(text)) return result;
      throw Object.assign(new Error(text), { stdout: result.stdout, stderr: result.stderr });
    } catch (error) {
      lastError = error;
      const text = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
      if (taskId(error) || !knownUploadFailure(text)) throw error;
      if (attempt < retries) await delay(attempt);
    }
  }
  lastError.code = "DREAMINA_REFERENCE_UPLOAD_NO_TASK";
  lastError.submissionOutcomeKnown = true;
  throw lastError;
};
