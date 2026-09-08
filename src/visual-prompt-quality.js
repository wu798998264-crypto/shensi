export const inspectVisualPrompt = (value) => {
  const text = String(value ?? "").trim();
  const issues = [];
  if (text.length < 80) issues.push("提示词过短，缺少可执行画面信息");
  if (!/(全景|中景|近景|特写|远景|景别|俯拍|仰拍|平视)/.test(text)) issues.push("缺少景别或机位");
  if (!/(推镜|拉镜|摇镜|移镜|跟拍|环绕|固定镜头|运镜|镜头)/.test(text)) issues.push("缺少运镜或镜头运动约束");
  if (!/(站在|坐在|位于|左侧|右侧|前景|中景|后景|走|转身|抬|看向|动作|站位)/.test(text)) issues.push("缺少人物站位或明确动作");
  if (!/(光|照明|逆光|侧光|顶光|自然光|霓虹|阴影)/.test(text)) issues.push("缺少光源描述");
  if (!/(质感|材质|写实|电影感|颗粒|细节|风格)/.test(text)) issues.push("缺少画面质感或风格约束");
  return { pass: issues.length === 0, issues };
};
