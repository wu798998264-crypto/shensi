import assert from "node:assert/strict";
import {
  emptyMemoryStore,
  projectMemoryStoreDocumentHtml,
  projectMemoryStoreMarkdown,
  trustedMemoryProjection,
  validateMemoryProjectionFormat,
} from "../src/structured-memory-store.js";
import { validateManagedDocumentFormat } from "../src/managed-document-format.js";

const store = emptyMemoryStore();
store.informationEntities["information-copper-seal"] = {
  id: "information-copper-seal",
  name: "铜兽印",
  detail: "父亲留下的铜兽印靠近矿洞时骤然发烫。",
  state: "局部揭示",
  status: "active",
  source: {
    documentId: "chapter-1",
    revision: "rev-1",
    quote: "父亲留下的铜兽印靠近矿洞时骤然发烫。",
    claim: "父亲留下的铜兽印靠近矿洞时骤然发烫。",
  },
  release: { state: "partial_reveal" },
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const markdown = projectMemoryStoreMarkdown({ store, documentId: "memory-release" });
const html = projectMemoryStoreDocumentHtml({ store, documentId: "memory-release" });
assert.equal(validateMemoryProjectionFormat({ documentId: "memory-release", markdown, html }).valid, true);
assert.deepEqual(trustedMemoryProjection({ store, documentId: "memory-release" }), {
  markdown,
  html,
  check: { valid: true, reason: "memory_projection_format_satisfied" },
});

assert.equal(validateMemoryProjectionFormat({
  documentId: "memory-release",
  content: `<shensi-deliverables><document id="memory-release">${markdown}</document></shensi-deliverables>`,
}).reason, "memory_projection_transport_wrapper");
assert.equal(validateMemoryProjectionFormat({
  documentId: "memory-release",
  content: "# 信息释放表\n\n<!-- memory-store-schema: 1 -->\n## 铜兽印\n- 稳定 ID：information-copper-seal",
}).reason, "memory_projection_record_fields");
assert.equal(validateManagedDocumentFormat({
  documentId: "memory-release",
  moduleId: "memory",
  content: markdown,
  systemProjection: true,
}).valid, true);
assert.equal(validateManagedDocumentFormat({
  documentId: "memory-release",
  moduleId: "memory",
  content: `<shensi-deliverables>${markdown}</shensi-deliverables>`,
  systemProjection: true,
}).reason, "memory_projection_transport_wrapper");

console.log("v3.1.7 memory projection format contract passed");
