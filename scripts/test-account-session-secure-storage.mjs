import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [preload, main, app] = await Promise.all([
  readFile(new URL("../packaging/windows/desktop-app/preload.cjs", import.meta.url), "utf8"),
  readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
]);

assert.match(preload, /readAccountSession/u);
assert.match(preload, /writeAccountSession/u);
assert.match(preload, /clearAccountSession/u);
assert.match(main, /shensi:credentials:read-account-session/u);
assert.match(main, /shensi:credentials:write-account-session/u);
assert.match(main, /shensi:credentials:clear-account-session/u);
assert.match(main, /shensi_account_session/u);
assert.match(app, /const accountSessionBridge = \(\) => window\.shensiDesktop/u);
assert.match(app, /bridge\.writeAccountSession\(\{ account, token, remember \}\)/u);
assert.match(app, /bridge\.readAccountSession()/u);
assert.match(app, /localStorage\.removeItem\("shensi-account-token"\)/u);
console.log("Account session secure-storage contract passed");
