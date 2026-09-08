const text = (value = "") => String(value ?? "").trim();

export const SERIES_OUTLINE_PATTERN = /全集大纲|全书大纲|全文大纲|整书大纲|小说大纲|总纲/u;
export const CHAPTER_OUTLINE_PATTERN = /章纲|细纲|详细大纲/u;

export const FORMAL_ASSET_TARGET_PATTERN = /(?:当前)?作品|(?:当前|绑定|目标|指定|对应|该|这个)文档|资料(?:库|文档)?|索引|备忘录|设定|世界观|人物(?:设定)?|角色(?:设定)?|全文大纲|全书大纲|全集大纲|整书大纲|小说大纲|总纲|大纲|卷纲|章纲|细纲|详细大纲|剧本|正文|章节|提示词|记忆|伏笔|信息(?:释放|台阶)|创作合同|项目总览|编译报告|待确认事项/u;
export const FORMAL_ASSET_WRITE_ACTION_PATTERN = /(?:写入|写进|加入|纳入|补进|落盘|保存到|存入|记入|记录到|同步到|创建|新建|生成|整理成|更新|修改)|(?:补充|增补|完善|增加|新增).{0,16}(?:资料(?:库|文档)?|设定|世界观|全文大纲|全书大纲|全集大纲|整书大纲|小说大纲|总纲|大纲|卷纲|章纲|细纲|详细大纲|记忆|伏笔|信息(?:释放|台阶))/u;
export const FORMAL_ASSET_WRITE_QUESTION_PATTERN = /(?:为什么|为何|怎么|如何|是否|能否|可不可以|会不会|有没有|什么原因).{0,30}(?:写入|落盘|保存|创建|新建|补充|更新|修改)|(?:写入|落盘|保存|创建|新建|补充|更新|修改).{0,24}(?:吗|呢|为什么|为何|怎么|如何|是否|能否|[?？])/u;
export const FORMAL_ASSET_WRITE_NEGATION_PATTERN = /(?:不要|无需|不必|禁止|不得|别|暂不|先不|不能|不可|不允许|不)(?:再|直接|继续|去)?[^，。！？；\n]{0,18}?(?:写入|落盘|保存|创建|新建|生成|记录|同步|补充|更新|修改)(?:(?:\s*(?:或|和|及|与|、|并|并且|以及)\s*)(?:写入|落盘|保存|创建|新建|生成|记录|同步|补充|更新|修改))?/u;

const EXPLICIT_CREATE_ACTION_PATTERN = /(?:新建|创建|另建|另起|新开)(?:一个|一份|一篇|一章|一集)?|新文档|新文件|new\s+(?:document|file)|新增\s*(?:(?:一个|一份|一篇|一章|一集)\s*)?(?:新的?\s*)?(?:文档|文件|章节|正文稿件|稿件)/iu;

export const hasExplicitNewDocumentAction = (value = "") => EXPLICIT_CREATE_ACTION_PATTERN.test(text(value));

export const hasFormalAssetWriteIntent = (value = "") => {
  const source = text(value);
  if (!source || FORMAL_ASSET_WRITE_QUESTION_PATTERN.test(source)) return false;
  // A single instruction may contain several independent exclusions (for
  // example, "不要生成正文，也不要创建文档"). Strip every negated action
  // before looking for an affirmative write action; otherwise the second
  // clause can incorrectly grant formal-write authority.
  const negationPattern = new RegExp(FORMAL_ASSET_WRITE_NEGATION_PATTERN.source, "gu");
  const affirmativeSource = source.replace(negationPattern, " ");
  return FORMAL_ASSET_WRITE_ACTION_PATTERN.test(affirmativeSource)
    && FORMAL_ASSET_TARGET_PATTERN.test(affirmativeSource);
};
