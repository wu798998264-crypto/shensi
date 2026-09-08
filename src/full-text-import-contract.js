export const fullTextImportInstructionRequested = (value = "") => {
  const source = String(value || "").replace(/[\s　]+/gu, "");
  if (!source || /(?:不要|无需|不必|禁止|取消|暂不|先不).{0,12}(?:导入|归档|落盘)/u.test(source)) return false;
  const scope = /全文|整本|全书|完整小说/u.test(source);
  const action = /导入|归档/u.test(source)
    || /(?:全文|整本|全书).{0,12}(?:拆分|分章).{0,12}(?:落盘|写入|保存)/u.test(source)
    || /(?:拆分|分章).{0,12}(?:全文|整本|全书).{0,12}(?:落盘|写入|保存)/u.test(source);
  if (!scope || !action) return false;
  const imperative = /请|现在|立即|开始|执行|直接|帮我|麻烦|把|将/u.test(source)
    || (/^(?:全文|整本|全书).{0,12}(?:导入|归档|落盘)$/u.test(source) && source.length <= 24);
  const discussion = /如何|怎么|是否|能否|可以吗|会不会|为什么|功能|规则|测试|检查|诊断|问题|[?？]/u.test(source);
  return imperative || !discussion;
};

export const fullTextImportDocumentTitle = ({ bookTitle = "", chapterTitle = "", chapterNumber = 0 } = {}) => {
  const book = String(bookTitle || "").trim();
  const chapter = String(chapterTitle || "").trim() || "未命名";
  const fallbackChapterTitle = Number(chapterNumber) > 0 && chapter === `第${Number(chapterNumber)}章`;
  return fallbackChapterTitle ? book : `${book}｜${chapter}`;
};
