const clean = (value = "") => String(value ?? "").trim();
const tokenEstimate = (value = "") => Math.ceil(String(value).length / 4);
const SAFETY_IDS = /^(?:safety|permission|workspace_boundary|history_snapshot|revision|idempotency|readback|irreversible_write|history_read)$/u;

const uniqueContracts = (contracts = []) => {
  const seen = new Set();
  return (Array.isArray(contracts) ? contracts : []).flatMap((item, index) => {
    const id = clean(item?.id) || `contract-${index + 1}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      lines: (Array.isArray(item?.lines) ? item.lines : [item?.prompt]).map(clean).filter(Boolean),
      summary: clean(item?.summary),
      priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : 50,
      safetyInvariant: item?.safetyInvariant === true || SAFETY_IDS.test(id),
    }];
  });
};

const routeConflicts = (route = {}, ids = new Set()) => {
  const conflicts = [];
  const candidateOnly = route.candidateOnly === true
    || route.landingPolicy === "candidate_only"
    || ids.has("candidate");
  if ((route.commitDisposition === "auto_commit" || ids.has("managed_commit")) && candidateOnly) {
    conflicts.push({
      code: "AUTO_COMMIT_CANDIDATE_ONLY",
      message: "auto_commit cannot be combined with candidate_only",
      contracts: ["managed_commit", "candidate"].filter((id) => ids.has(id)),
    });
  }
  const canonModes = new Set([
    clean(route.canonMode),
    ...(Array.isArray(route.requestedCanonModes) ? route.requestedCanonModes.map(clean) : []),
  ].filter(Boolean));
  if (canonModes.has("strict") && canonModes.has("alternate")) {
    conflicts.push({
      code: "STRICT_ALTERNATE_CONFLICT",
      message: "strict canon and alternate version modes cannot govern the same artifact",
      contracts: [],
    });
  }
  return conflicts;
};

const render = (contracts) => contracts.flatMap((item) => item.lines).join("\n");

export const compileAgentPromptBudget = ({ contracts = [], route = {}, budgetTokens = 1_800 } = {}) => {
  const normalized = uniqueContracts(contracts);
  const limit = Math.max(32, Number(budgetTokens) || 1_800);
  const safetyTokenEstimate = tokenEstimate(render(normalized.filter((item) => item.safetyInvariant)));
  const compressedIds = [];
  const omittedIds = [];
  let selected = normalized.map((item) => ({ ...item, lines: [...item.lines] }));

  if (tokenEstimate(render(selected)) > limit) {
    selected = selected.map((item) => {
      if (item.safetyInvariant) return item;
      const summary = item.summary || item.lines.find((line) => !/^<\/?[^>]+>$/u.test(line)) || item.id;
      compressedIds.push(item.id);
      return { ...item, lines: [`<shensi_contract_summary id=${JSON.stringify(item.id)}>`, summary.slice(0, 240), "</shensi_contract_summary>"] };
    });
  }

  if (tokenEstimate(render(selected)) > limit) {
    for (const item of [...selected].filter((entry) => !entry.safetyInvariant).sort((left, right) => left.priority - right.priority)) {
      if (tokenEstimate(render(selected)) <= limit) break;
      selected = selected.filter((entry) => entry.id !== item.id);
      omittedIds.push(item.id);
    }
  }

  const prompt = render(selected);
  const conflictReport = routeConflicts(route, new Set(normalized.map((item) => item.id)));
  return {
    valid: conflictReport.length === 0,
    prompt,
    contractCount: normalized.length,
    emittedContractCount: selected.length,
    tokenEstimate: tokenEstimate(prompt),
    budgetTokens: limit,
    safetyTokenEstimate,
    compressedIds: [...new Set(compressedIds)],
    omittedIds: [...new Set(omittedIds)],
    conflictReport,
    summaries: normalized.map((item) => ({
      id: item.id,
      priority: item.priority,
      safetyInvariant: item.safetyInvariant,
      tokenEstimate: tokenEstimate(item.lines.join("\n")),
    })),
  };
};
