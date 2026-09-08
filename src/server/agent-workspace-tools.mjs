export const SHENSI_WORKSPACE_TOOL_PROTOCOL_VERSION = "shensi_workspace_tools_v1";

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const string = (description) => ({ type: "string", description });
const integer = (description, minimum = 0) => ({ type: "integer", description, minimum });
const boolean = (description) => ({ type: "boolean", description });
const historyAccessProperties = () => ({
  historyReason: string("Required when the Agent independently requests historical evidence: a concrete read-only reason."),
  historyGapId: string("Required with historyReason when history was not explicitly requested by the user: the task gap this read addresses."),
});

const tool = (name, description, inputSchema) => ({
  type: "function",
  name,
  description,
  inputSchema,
});

export const workspaceDynamicToolSpecs = () => [{
  type: "namespace",
  name: "workspace",
  description: "Read-only access to the current Shensi workspace. Search first, then read only the necessary ranges. Historical results are non-canon and require separate authorization.",
  tools: [
    tool("structure", "Return workspace kind, modules, readable roots, permissions, budgets, and document counts.", objectSchema()),
    tool("list", "List files and directories under an authorized workspace path without reading file bodies.", objectSchema({
      path: string("Relative workspace directory; defaults to the workspace root."),
      depth: integer("Traversal depth, capped by the host."),
      page: integer("One-based page number.", 1),
      pageSize: integer("Requested page size, capped by the host.", 1),
      fileTypes: { type: "array", items: { type: "string" } },
      name: string("Optional case-insensitive name filter."),
      ...historyAccessProperties(),
    })),
    tool("search", "Search authorized workspace names and indexed text. Use returned paths with workspace.read_range.", objectSchema({
      query: string("Required search query."),
      path: string("Optional relative directory scope."),
      page: integer("One-based page number.", 1),
      pageSize: integer("Requested page size, capped by the host.", 1),
      fileTypes: { type: "array", items: { type: "string" } },
      pathFilter: string("Optional relative path substring filter."),
      ...historyAccessProperties(),
    }, ["query"])),
    tool("read", "Read the beginning of one authorized text file within the host character budget.", objectSchema({
      path: string("Required relative path or authorized absolute path."),
      explicit: boolean("True only when the user explicitly named this file."),
      ...historyAccessProperties(),
    }, ["path"])),
    tool("read_range", "Read a bounded character or line range from one authorized text file.", objectSchema({
      path: string("Required relative path or authorized absolute path."),
      start: integer("Zero-based start character."),
      end: integer("Exclusive end character."),
      startLine: integer("One-based start line; overrides character offsets when set.", 1),
      endLine: integer("Inclusive end line.", 1),
      explicit: boolean("True only when the user explicitly named this file."),
      ...historyAccessProperties(),
    }, ["path"])),
    tool("resolve_reference", "Resolve a Shensi document id, URI, or path to current read-only workspace metadata.", objectSchema({
      reference: string("Document id, shensi document URI, or path."),
      currentTarget: string("Fallback target when reference is omitted."),
      ...historyAccessProperties(),
    })),
    tool("document_revision", "Return current revision and concurrent-modification status before relying on or committing against a document.", objectSchema({
      path: string("Relative file path."),
      documentId: string("Shensi document id."),
      expectedRevision: string("Optional revision expected by the caller."),
      ...historyAccessProperties(),
    })),
    tool("read_history_version", "Read exactly one user-authorized historical version of one current-workspace document. Historical content is non-canon, read-only, and never a commit baseline.", objectSchema({
      documentId: string("Required Shensi document id within the current workspace and current task authorization."),
      versionSelector: string("Required authorized version id, visible version label, or relative selector: previous, latest, or oldest."),
    }, ["documentId", "versionSelector"])),
  ],
}];

const normalizedArguments = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return {};
};

const response = (success, payload) => ({
  success,
  contentItems: [{ type: "inputText", text: JSON.stringify(payload) }],
});

export const createAgentWorkspaceToolRuntime = ({ broker, exposeAbsolutePaths = true } = {}) => {
  if (!broker || typeof broker !== "object") throw new Error("Workspace tool runtime requires one broker instance.");
  const dynamicTools = workspaceDynamicToolSpecs();
  const allowed = new Set(dynamicTools[0].tools.map((entry) => entry.name));

  const invoke = async ({ namespace = "", tool: toolName = "", arguments: args = {} } = {}) => {
    const name = String(toolName || "").trim();
    if (namespace !== "workspace" || !allowed.has(name) || typeof broker[name] !== "function") {
      return response(false, {
        ok: false,
        error: { code: "WORKSPACE_TOOL_UNAVAILABLE", message: `Unsupported read-only workspace tool: ${namespace || "(none)"}.${name || "(none)"}` },
      });
    }
    try {
      const rawResult = await broker[name](normalizedArguments(args));
      const result = exposeAbsolutePaths === false && name === "structure"
        ? { ...rawResult, root: ".", readableRoots: ["."] }
        : rawResult;
      return response(true, { ok: true, method: `workspace.${name}`, result });
    } catch (error) {
      return response(false, {
        ok: false,
        method: `workspace.${name}`,
        error: {
          code: String(error?.code || "WORKSPACE_TOOL_FAILED"),
          message: String(error?.message || error || "Workspace tool failed").slice(0, 1_000),
        },
      });
    }
  };

  return { protocolVersion: SHENSI_WORKSPACE_TOOL_PROTOCOL_VERSION, dynamicTools, invoke };
};
