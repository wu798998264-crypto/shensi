const clean = (value = "") => String(value)
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ")
  .trim();

const compact = (value = "", max = 24) => {
  const text = clean(value)
    .replace(/^[，。；：、\s]+|[，。；：、\s]+$/g, "")
    .replace(/^(?:请|麻烦|帮我|帮忙|现在|然后|需要|我要|把|将)+/g, "")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const documentText = (documentState = {}) => clean(documentState.html ?? documentState.text ?? documentState.markdown ?? "");
const documentTitle = (documentState = {}) => compact(documentState.title ?? "", 22);
const corpusFor = (documents = {}) => Object.values(documents).map(documentText).filter(Boolean).join("\n");

const placeholderPattern = /(?:占位文档|正文尚未展开|内容尚未展开|尚未开始|尚未填写|等待.{0,16}(?:确定|补充|创作)|可在右侧对话|当前没有(?:正文|内容)|暂无(?:正文|内容))/;
const femalePattern = /(?:女频文?|女主视角|女频向|真假千金|追妻火葬场|豪门虐恋)/;
const malePattern = /(?:男频文?|男主视角|男频向|升级流|系统流|赘婿逆袭)/;

const genreOf = (value = "") => {
  const text = clean(value);
  if (femalePattern.test(text)) return "女频文";
  if (malePattern.test(text)) return "男频文";
  return "";
};

export const historyContentFeature = ({ documents = {}, fallbackLabel = "文档" } = {}) => {
  const entries = Object.values(documents).filter(Boolean);
  const texts = entries.map(documentText);
  const corpus = texts.join("\n");
  if (!entries.length || !corpus || texts.every((text) => !text || placeholderPattern.test(text))) return "占位文档";
  const genre = genreOf(corpus);
  if (genre) return genre;
  if (entries.length === 1) return documentTitle(entries[0]) || compact(fallbackLabel, 22) || "文档";
  return compact(fallbackLabel, 22) || "多文档";
};

const quotedRename = (value = "") => {
  const source = clean(value);
  const match = source.match(/(?:人物名|角色名|人物|角色|姓名|名字)[^\u4e00-\u9fa5·]{0,6}[“"']?([\u4e00-\u9fa5·]{2,8})[”"']?\s*(?:改成|改为|修改为|替换成|替换为|改|替换)\s*[“"']?([\u4e00-\u9fa5·]{2,8})/);
  return match ? { before: match[1], after: match[2] } : null;
};

const prominentAiChange = (value = "") => {
  const source = clean(value);
  const action = source.match(/(?:整体|全文|局部)?(?:重写|改写|修改|调整|优化|润色|续写|扩写|压缩|补写|替换|生成|创作)/)?.[0] || "";
  if (!action) return "";
  const target = source.match(/第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*[章节集]|人物设定|角色设定|世界观(?:设定)?|时间线|章纲|卷纲|全集大纲|剧本|正文|开头|结尾|选中(?:段落|文字)?/)?.[0] || "";
  const detail = source.match(/(?:改成|改为|调整为|重写为|突出|强化|增加|删去|删除|补充|聚焦|围绕)[：:\s]*([^，。；！？\n]{2,18})/)?.[1]
    || source.match(/[“《]([^”》\n]{2,18})[”》]/)?.[1]
    || "";
  const label = [action, target].filter(Boolean).join("");
  return compact(detail ? `${label}·${detail}` : label, 28);
};

const operationInstruction = (operations = [], beforeCorpus = "", reason = "") => {
  const list = Array.isArray(operations) ? operations.filter(Boolean) : [];
  if (!list.length) return "";
  if (list.some(({ type }) => type === "document.clear" || type === "scope.clear")) return "清空";

  const replaceText = list.find(({ type, find, replace }) => type === "document.replace_text" && find && replace != null);
  if (replaceText) {
    const explicitPersonRename = /人物|角色|姓名|名字/.test(reason);
    const shortChinesePair = /^[\u4e00-\u9fa5·]{2,4}$/.test(replaceText.find) && /^[\u4e00-\u9fa5·]{2,4}$/.test(replaceText.replace);
    if (explicitPersonRename || (replaceText.replaceAll && shortChinesePair && clean(beforeCorpus).split(replaceText.find).length > 2)) {
      return `人物名${replaceText.find}修改${replaceText.replace}`;
    }
    return `${compact(replaceText.find, 10)}修改${compact(replaceText.replace, 10)}`;
  }

  const replaceContent = list.find(({ type }) => type === "document.replace_content");
  if (replaceContent) {
    const beforeGenre = genreOf(beforeCorpus);
    const afterGenre = genreOf(replaceContent.content);
    if (beforeGenre && afterGenre && beforeGenre !== afterGenre) return `转${afterGenre.replace(/文$/, "")}`;
    if (/男频/.test(reason)) return "转男频";
    if (/女频/.test(reason)) return "转女频";
    return "全文修改";
  }

  const rename = list.find(({ type }) => type === "document.rename");
  if (rename) return `重命名为${compact(rename.title, 16)}`;
  if (list.some(({ type }) => type === "document.append_content")) return "追加内容";
  if (list.some(({ type }) => type === "document.delete" || type === "project.delete")) return "删除";
  if (list.some(({ type }) => type === "document.move")) return "移动位置";
  if (list.some(({ type }) => type === "document.reorder")) return "调整顺序";
  if (list.some(({ type }) => type === "document.create")) return "新增文档";
  if (list.some(({ type }) => type === "history.restore" || type === "trash.restore")) return "恢复";
  if (list.some(({ type }) => type === "history.save_document")) return "版本保存";
  return "";
};

export const historyInstructionLabel = ({ reason = "", operations = [], beforeDocuments = {} } = {}) => {
  const source = clean(reason);
  const beforeCorpus = corpusFor(beforeDocuments);
  const fromOperation = operationInstruction(operations, beforeCorpus, source);
  if (fromOperation) return fromOperation;
  const personRename = quotedRename(source);
  if (personRename) return `人物名${personRename.before}修改${personRename.after}`;
  if (/女频.{0,10}(?:转|改|调整|转换).{0,6}男频|(?:转成?|改成?|改为|调整为)男频|男频化/.test(source)) return "转男频";
  if (/男频.{0,10}(?:转|改|调整|转换).{0,6}女频|(?:转成?|改成?|改为|调整为)女频|女频化/.test(source)) return "转女频";
  if (/清空/.test(source)) return "清空";
  if (/版本保存|保存版本|手动保存/.test(source)) return "版本保存";
  if (/局部替换|局部修改|选中.{0,8}(?:修改|替换)/.test(source)) return "局部修改";
  if (/重命名|改名/.test(source)) return compact(source.replace(/.*?(?:重命名|改名)/, "重命名"), 22);
  if (/恢复|设为当前/.test(source)) return "恢复历史";
  if (/删除|移入回收/.test(source)) return "删除";
  if (/新增|新建|创建/.test(source)) return "新增内容";
  if (/自检/.test(source)) return "写入自检结果";
  if (/落盘/.test(source)) return compact(source.replace(/落盘/g, "").trim(), 22) || "内容落盘";
  const aiChange = prominentAiChange(source);
  if (aiChange) return aiChange;
  const internal = /(?:对应范围版本|修改前|替换前|写入前|采用前|结构$|当前编辑版本)/.test(source);
  return internal ? "内容修改" : compact(source, 22) || "内容修改";
};

export const historyVersionTitle = ({ documents = {}, fallbackLabel = "文档", reason = "", operations = [] } = {}) => {
  const feature = historyContentFeature({ documents, fallbackLabel });
  const instruction = historyInstructionLabel({ reason, operations, beforeDocuments: documents });
  if (/^人物名/.test(instruction)) return instruction;
  if (feature === "女频文" && instruction === "转男频") return "女频文转男频";
  if (feature === "男频文" && instruction === "转女频") return "男频文转女频";
  return `${feature}${instruction}`;
};
