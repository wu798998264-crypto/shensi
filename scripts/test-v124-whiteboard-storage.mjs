import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlankProjectState } from "../src/data.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";
import { canvasNodeIdAtPoint } from "../src/whiteboard-connection-target.js";

const root = await mkdtemp(join(tmpdir(), "shensi-v124-whiteboard-"));
const appRoot = join(root, "app");
const workspacePath = join(appRoot, "runtime", "whiteboard-storage");
const whiteboardId = "manuscript-whiteboard-v124";

try {
  const hitNodes = [
    { id: "source-a", x: 0, y: 0, width: 100, height: 100 },
    { id: "source-b", x: 120, y: 0, width: 100, height: 100 },
    { id: "existing-target", x: 300, y: 30, width: 260, height: 160 },
  ];
  assert.equal(canvasNodeIdAtPoint({ nodes: hitNodes, point: { x: 420, y: 90 }, excludedNodeIds: ["source-a", "source-b"] }), "existing-target");
  assert.equal(canvasNodeIdAtPoint({ nodes: hitNodes, point: { x: 50, y: 50 }, excludedNodeIds: ["source-a", "source-b"] }), "");
  assert.equal(canvasNodeIdAtPoint({ nodes: hitNodes, point: { x: 900, y: 900 }, excludedNodeIds: ["source-a", "source-b"] }), "");
  const state = createBlankProjectState("whiteboard-storage");
  state.documents[whiteboardId] = {
    title: "Acceptance Whiteboard",
    documentKind: "whiteboard",
    moduleId: "manuscript",
    workspaceView: "novel",
    placementOverride: true,
    canvas: {
      nodes: [{ id: "card-1", type: "text", x: 10, y: 20, width: 240, height: 120, text: "real canvas content" }],
      edges: [],
      assets: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { snapToGrid: true, gridSize: 20 },
    },
  };
  state.moduleItems.manuscript ??= [];
  state.moduleItems.manuscript.push([whiteboardId, "Acceptance Whiteboard", { workspaceView: "novel" }]);

  const saved = await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state, operationDocumentIds: [whiteboardId] });
  const entry = saved.manifest[whiteboardId];
  assert.match(entry.path, /\.canvas$/u, "project whiteboards must use the .canvas extension");
  const physicalPath = join(workspacePath, entry.path);
  const serialized = JSON.parse(await readFile(physicalPath, "utf8"));
  assert.equal(serialized.nodes[0].text, "real canvas content");

  await writeFile(physicalPath, "not valid canvas json", "utf8");
  const isolated = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(isolated.state.documents[whiteboardId].externalContentCorrupt, true);
  assert.ok(Object.keys(isolated.state.documents).some((id) => id !== whiteboardId), "one damaged whiteboard must not block unrelated documents");
  console.log("v1.2.4 project whiteboard serialization and corruption isolation passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
