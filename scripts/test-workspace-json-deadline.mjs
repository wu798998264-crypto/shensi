import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const start = app.indexOf("const fetchWorkspaceRequest = ");
const end = app.indexOf("\n};", start);
let requested = 0;
const context = vm.createContext({ AbortController, DOMException, setTimeout, clearTimeout,
  fetch: async (_url, { signal }) => {
    requested += 1;
    // Headers arrive immediately but the JSON body never finishes.
    return { json: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) };
  },
});
vm.runInContext(app.slice(start, end + 3), context);
await assert.rejects(vm.runInContext('fetchWorkspaceRequest("/test", {}, 5, (response) => response.json())', context), (error) => error.code === "WORKSPACE_REQUEST_TIMEOUT");
assert.equal(requested, 1, "timeout does not create any automatic network retries");
context.fetch = async () => ({ json: async () => ({ ok: true, marker: "saved" }) });
const saved = await vm.runInContext('fetchWorkspaceRequest("/test", {}, 50, (response) => response.json())', context);
assert.equal(saved.marker, "saved");
assert.match(app, /fetchWorkspaceRequest\("\/api\/recovery\/checkpoint"[\s\S]{0,350}payload: await response\.json\(\)/u);
assert.match(app, /lastError\?\.code === "WORKSPACE_REQUEST_TIMEOUT"\) break/u);
console.log("Workspace readback/checkpoint deadlines cover response bodies without extra requests or false success");
