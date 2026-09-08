import assert from "node:assert/strict";
import { nativeWebSearchFallbackEligible } from "../src/server/web-search-fallback-policy.mjs";

assert.equal(nativeWebSearchFallbackEligible({ message: "Connection failed. Reconnecting..." }), true);
assert.equal(nativeWebSearchFallbackEligible({ code: "HTTP_503", message: "native web search unavailable" }), true);
assert.equal(nativeWebSearchFallbackEligible({ message: "invalid API key" }), false);
assert.equal(nativeWebSearchFallbackEligible({ message: "insufficient_quota" }), false);
assert.equal(nativeWebSearchFallbackEligible({ message: "task cancelled by user" }), false);
assert.equal(nativeWebSearchFallbackEligible({ message: "模型不存在" }), false);
console.log("Web search fallback policy tests passed");
