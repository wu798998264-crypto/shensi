import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { shouldRefreshLocalSession } from "../src/local-session-retry.js";

assert.equal(shouldRefreshLocalSession({ status: 403, errorCode: "LOCAL_SESSION_EXPIRED" }), true);
assert.equal(shouldRefreshLocalSession({ status: 403, errorCode: "PROVIDER_FORBIDDEN" }), false);
assert.equal(shouldRefreshLocalSession({ status: 403, errorCode: "" }), false);
assert.equal(shouldRefreshLocalSession({ status: 401, errorCode: "LOCAL_SESSION_EXPIRED" }), false);
assert.equal(shouldRefreshLocalSession({ status: 403, errorCode: "LOCAL_SESSION_EXPIRED", alreadyRetried: true }), false);

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /requestError\("本地会话已失效[^\n]+403,\s*"LOCAL_SESSION_EXPIRED"\)/u);
assert.match(serverSource, /setHeader\("X-Shensi-Error-Code",\s*"LOCAL_SESSION_EXPIRED"\)/u);

console.log("local-session expiry-only retry contract tests passed; unrelated 403 responses remain single-shot");
