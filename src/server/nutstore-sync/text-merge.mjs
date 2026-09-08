const lines = (value) => String(value ?? "").split("\n");
const equalLines = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

const singleEdit = (base, changed) => {
  let start = 0;
  while (start < base.length && start < changed.length && base[start] === changed[start]) start += 1;
  let baseEnd = base.length;
  let changedEnd = changed.length;
  while (baseEnd > start && changedEnd > start && base[baseEnd - 1] === changed[changedEnd - 1]) {
    baseEnd -= 1;
    changedEnd -= 1;
  }
  return { start, end: baseEnd, replacement: changed.slice(start, changedEnd) };
};

const overlaps = (a, b) => {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
};

export const mergeTextThreeWay = ({ base = "", local = "", remote = "" } = {}) => {
  if (local === remote) return { conflict: false, text: local, strategy: "identical" };
  if (local === base) return { conflict: false, text: remote, strategy: "remote_only" };
  if (remote === base) return { conflict: false, text: local, strategy: "local_only" };
  const baseLines = lines(base);
  const localEdit = singleEdit(baseLines, lines(local));
  const remoteEdit = singleEdit(baseLines, lines(remote));
  if (localEdit.start === remoteEdit.start && localEdit.end === remoteEdit.end && equalLines(localEdit.replacement, remoteEdit.replacement)) {
    return { conflict: false, text: local, strategy: "same_edit" };
  }
  if (overlaps(localEdit, remoteEdit)) return { conflict: true, text: base, strategy: "overlap", local, remote, base };
  const output = [...baseLines];
  for (const edit of [localEdit, remoteEdit].sort((a, b) => b.start - a.start)) output.splice(edit.start, edit.end - edit.start, ...edit.replacement);
  return { conflict: false, text: output.join("\n"), strategy: "non_overlapping" };
};

