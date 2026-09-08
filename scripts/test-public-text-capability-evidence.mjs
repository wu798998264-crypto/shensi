import assert from "node:assert/strict";
import {
  classifyPublicTextCapabilityFailure,
  describePublicTextCapabilityFailure,
  publicTextFailureIsRequestSpecific,
} from "../src/public-text-capability-evidence.js";

assert.equal(classifyPublicTextCapabilityFailure({ message: "Provider returned error" }), "unknown");
assert.match(
  describePublicTextCapabilityFailure({ message: "Provider returned error" }, "unknown"),
  /没有返回足以判断的错误证据/u,
);

assert.equal(classifyPublicTextCapabilityFailure({ code: "HTTP_429", statusCode: 429 }), "temporarily_unavailable");
assert.equal(classifyPublicTextCapabilityFailure({ message: "Rate limit exceeded" }), "temporarily_unavailable");
assert.match(
  describePublicTextCapabilityFailure({
    code: "HTTP_429",
    providerErrorCode: "rate_limit_exceeded",
    statusCode: 429,
    retryAfterMs: 7_000,
    message: "Provider returned error",
  }, "temporarily_unavailable"),
  /限流或线路繁忙.*HTTP 429.*rate_limit_exceeded.*7 秒后重试/u,
);

assert.equal(classifyPublicTextCapabilityFailure({ statusCode: 503, message: "upstream unavailable" }), "temporarily_unavailable");
assert.equal(classifyPublicTextCapabilityFailure({ statusCode: 401 }), "authentication_required");
assert.equal(classifyPublicTextCapabilityFailure({ statusCode: 502, providerErrorCode: "auth_unavailable", message: "no auth available" }), "upstream_auth_unavailable");
assert.match(
  describePublicTextCapabilityFailure({ statusCode: 502, providerErrorCode: "auth_unavailable", message: "no auth available" }, "upstream_auth_unavailable"),
  /上游认证池没有可用凭据.*用户配置未被清除/u,
);
assert.equal(classifyPublicTextCapabilityFailure({ statusCode: 403 }), "permission_denied");
assert.equal(classifyPublicTextCapabilityFailure({ statusCode: 404, message: "model not found" }), "unsupported");
assert.equal(classifyPublicTextCapabilityFailure({ statusCode: 402 }), "quota_exhausted");
assert.equal(classifyPublicTextCapabilityFailure({ code: "MODEL_EMPTY_TEXT" }, { responseWithoutText: true }), "response_without_text");
assert.equal(publicTextFailureIsRequestSpecific({ code: "context_length_exceeded", message: "maximum context length exceeded" }), true);
assert.equal(publicTextFailureIsRequestSpecific({ message: "Provider returned error" }), false);

console.log("Public text capability evidence tests passed");
