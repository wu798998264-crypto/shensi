import { resolve } from "node:path";

const BROKERED_MODEL_CWD_VERSION = "brokered-model-cwd-v1";

// Shensi compiles the authorized document/context before invoking a model.
// The model process therefore never needs the managed workspace path as its
// current working directory. Keeping it in an application-owned empty
// directory prevents a read-only external document, virtual notebook URI, or
// custom Agent project from being mistaken for a writable workspace root.
export const brokeredModelExecutionRoot = ({ machineRoot }) => resolve(
  String(machineRoot || ""),
  "machine-sessions",
  BROKERED_MODEL_CWD_VERSION,
);

