const value = (input = "") => String(input ?? "");

export const escapeHistoryDiffHtml = (input = "") => value(input)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const fallbackChangeSet = (before, after) => {
  if (before === after) return [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return [{
    editId: "legacy-diff",
    start: prefix,
    end: before.length - suffix,
    before: before.slice(prefix, before.length - suffix),
    after: after.slice(prefix, after.length - suffix),
  }];
};

const parsedHistoryChangeSet = (changeSet = []) => (Array.isArray(changeSet) ? changeSet : []).map((change, index) => ({
    editId: value(change?.editId) || `change-${index + 1}`,
    start: Number(change?.start),
    end: Number(change?.end),
    before: value(change?.before),
    after: value(change?.after),
  }));

export const replayHistoryChangeSet = (before = "", changeSet = []) => {
  const source = value(before);
  let cursor = 0;
  let output = "";
  for (const change of changeSet) {
    output += source.slice(cursor, change.start);
    output += change.after;
    cursor = change.end;
  }
  return `${output}${source.slice(cursor)}`;
};

export const validateHistoryChangeSet = (changeSet = [], before = "", after = "") => {
  const source = value(before);
  const target = value(after);
  const changes = parsedHistoryChangeSet(changeSet);
  if (!changes.length) return { valid: false, changes: [], reason: "empty" };
  let cursor = 0;
  for (const change of changes) {
    if (!Number.isInteger(change.start) || !Number.isInteger(change.end)) {
      return { valid: false, changes: [], reason: "invalid-range" };
    }
    if (change.start < cursor || change.start < 0 || change.end < change.start || change.end > source.length) {
      return { valid: false, changes: [], reason: "overlap-or-out-of-range" };
    }
    if (source.slice(change.start, change.end) !== change.before) {
      return { valid: false, changes: [], reason: "before-mismatch" };
    }
    cursor = change.end;
  }
  if (replayHistoryChangeSet(source, changes) !== target) {
    return { valid: false, changes: [], reason: "replay-mismatch" };
  }
  return { valid: true, changes, reason: "verified" };
};

export const normalizeHistoryChangeSet = (changeSet = [], before = "", after = "") => {
  const verified = validateHistoryChangeSet(changeSet, before, after);
  return verified.valid ? verified.changes : fallbackChangeSet(value(before), value(after));
};

export const resolveHistoryDiffInput = ({
  changeSet = [],
  explicitBefore = "",
  hasExplicitBefore = false,
  parentBefore = "",
  snapshotAfter = "",
  hasParent = false,
  hasSnapshot = true,
} = {}) => {
  const explicitChanges = Array.isArray(changeSet) ? changeSet : [];
  const snapshot = value(snapshotAfter);
  if (!hasSnapshot) {
    return {
      hasDiff: false,
      before: "",
      after: "",
      changeSet: [],
      source: "missing-complete-snapshot",
      integrityError: "历史正文快照不完整，已停止显示残缺内容",
    };
  }
  const parent = value(parentBefore);
  if (explicitChanges.length) {
    // A change set only marks ranges. Both sides of the preview must still be
    // complete document bodies: the parent snapshot when available, otherwise
    // the full pre-edit body captured with the partial write. The selected
    // version's complete snapshot is always the after side.
    const completeBefore = hasParent ? parent : hasExplicitBefore ? value(explicitBefore) : snapshot;
    const completeAfter = snapshot;
    const verified = validateHistoryChangeSet(explicitChanges, completeBefore, completeAfter);
    if (verified.valid) {
      return {
        hasDiff: true,
        before: completeBefore,
        after: completeAfter,
        changeSet: verified.changes,
        source: "stored-change-set",
      };
    }
    if (hasParent && parent !== snapshot) {
      return {
        hasDiff: true,
        before: parent,
        after: snapshot,
        changeSet: fallbackChangeSet(parent, snapshot),
        source: "rebuilt-from-snapshots",
        rejectedChangeSetReason: verified.reason,
      };
    }
    return {
      hasDiff: false,
      before: completeAfter,
      after: completeAfter,
      changeSet: [],
      source: "full-snapshot",
      rejectedChangeSetReason: verified.reason,
    };
  }
  const after = snapshot;
  if (!hasParent || parent === after) {
    return { hasDiff: false, before: after, after, changeSet: [], source: "full-snapshot" };
  }
  return { hasDiff: true, before: parent, after, changeSet: [], source: "parent-snapshot" };
};

export const renderHistoryDiff = ({ before = "", after = "", changeSet = [] } = {}) => {
  const beforeSource = value(before);
  const changes = normalizeHistoryChangeSet(changeSet, before, after);
  if (!changes.length) return `<div class="history-diff-content">${escapeHistoryDiffHtml(beforeSource)}</div>`;
  let cursor = 0;
  const fragments = [];
  for (const change of changes) {
    fragments.push(escapeHistoryDiffHtml(beforeSource.slice(cursor, change.start)));
    if (change.before && change.after) {
      fragments.push(`<span class="history-diff-modified" data-history-change-type="modified" title="修改"><span class="history-diff-removed">${escapeHistoryDiffHtml(change.before)}</span><span class="history-diff-added">${escapeHistoryDiffHtml(change.after)}</span></span>`);
    } else if (change.before) {
      fragments.push(`<span class="history-diff-removed" data-history-change-type="deleted" title="删除">${escapeHistoryDiffHtml(change.before)}</span>`);
    } else if (change.after) {
      fragments.push(`<span class="history-diff-added" data-history-change-type="added" title="新增">${escapeHistoryDiffHtml(change.after)}</span>`);
    }
    cursor = change.end;
  }
  fragments.push(escapeHistoryDiffHtml(beforeSource.slice(cursor)));
  return `<div class="history-diff-content history-diff-inline">${fragments.join("")}</div>`;
};
