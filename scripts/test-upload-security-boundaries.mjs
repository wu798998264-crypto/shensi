import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { saveWorkspaceAttachmentFromStream } from "../src/server/workspace.mjs";

const [serverSource, workspaceSource] = await Promise.all([
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/workspace.mjs", import.meta.url), "utf8"),
]);

assert.match(serverSource, /expectedBytes\s*<=\s*0/u,
  "multipart 上传必须拒绝缺失或零字节声明");
assert.match(serverSource, /MULTIPART_UPLOAD_IDLE_TIMEOUT_MS/u,
  "multipart 上传必须有空闲超时");
assert.match(serverSource, /MULTIPART_UPLOAD_TOTAL_TIMEOUT_MS/u,
  "multipart 上传必须有总时限");
assert.match(workspaceSource, /MEDIA_MIME_MISMATCH/u,
  "媒体上传必须拒绝声明 MIME 与真实格式不一致");
assert.match(workspaceSource, /quotaRoot/u,
  "附件配额必须按工作区附件根目录累计，而不是按单个子目录");

const root = await mkdtemp(join(tmpdir(), "shensi-upload-security-"));
const listFiles = async (directory) => {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(target));
    else result.push(target);
  }
  return result;
};

try {
  const invalidMedia = Buffer.from("not-a-png");
  await assert.rejects(
    saveWorkspaceAttachmentFromStream({
      appRoot: root,
      requestedPath: join(root, "runtime", "mime-mismatch"),
      name: "fake.png",
      mimeType: "image/png",
      stream: Readable.from([invalidMedia]),
      expectedBytes: invalidMedia.length,
    }),
    (error) => error?.code === "MEDIA_MIME_MISMATCH",
    "伪造 PNG 必须在落盘前被拒绝",
  );

  const filesAfterReject = await listFiles(root);
  assert.equal(filesAfterReject.some((file) => file.endsWith(".upload")), false,
    "媒体类型拒绝后不得残留临时上传文件");

  const opaque = Buffer.from("opaque attachment");
  const accepted = await saveWorkspaceAttachmentFromStream({
    appRoot: root,
    requestedPath: join(root, "runtime", "unknown-size"),
    name: "reference.bin",
    mimeType: "application/octet-stream",
    stream: Readable.from([opaque]),
    expectedBytes: 0,
  });
  assert.equal(accepted.size, opaque.length, "内部未知长度流仍应按实际字节数验收");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Upload security boundary regression passed");
