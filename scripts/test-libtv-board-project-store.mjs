import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLibTvBoardProject, libTvBoardScope } from "../src/server/libtv-board-project-store.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-libtv-board-"));
const job = { id: "job-1", target: { workspacePath: "E:/data/笔记/我的笔记", documentId: "board-1", documentKind: "whiteboard" } };
const scope = libTvBoardScope(job, "account-a");
let creates = 0;
const create = async () => { creates++; await new Promise(resolve => setTimeout(resolve, 10)); return "canvas-1"; };
try {
  const both = await Promise.all([getLibTvBoardProject({ root, scope, jobId: "job-1", create }), getLibTvBoardProject({ root, scope, jobId: "job-2", create })]);
  assert.equal(creates, 1); assert.equal(both[0].projectUuid, both[1].projectUuid); assert.notEqual(both[0].slot, both[1].slot);
  const restarted = await getLibTvBoardProject({ root, scope, jobId: "job-1", create });
  assert.equal(restarted.slot, both[0].slot); assert.equal(creates, 1);
  assert.notEqual(libTvBoardScope(job, "account-b").key, scope.key);
  assert.notEqual(libTvBoardScope({ ...job, target: { ...job.target, documentId: "board-2" } }, "account-a").key, scope.key);
  assert.equal(libTvBoardScope({ target: {} }, "account-a"), null);
  const uncertain = libTvBoardScope(job, "unknown-create");
  await assert.rejects(getLibTvBoardProject({ root, scope: uncertain, jobId: "u", create: async () => { throw new Error("connection lost after create"); } }), /connection lost/u);
  await assert.rejects(getLibTvBoardProject({ root, scope: uncertain, jobId: "u", create, recover: async () => "" }), /不能再次创建/u);
  assert.equal(creates, 1);
  const recovered = await getLibTvBoardProject({ root, scope: uncertain, jobId: "u", create, recover: async () => "original-remote-canvas" });
  assert.equal(recovered.projectUuid, "original-remote-canvas"); assert.equal(creates, 1);
  console.log("LibTV account/whiteboard canvas reuse, concurrency and interrupted creation passed");
} finally { await rm(root, { recursive: true, force: true }); }
