const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const runtimeScripts = new Set(['scripts/launcher.mjs', 'scripts/update-installer-helper.mjs', 'scripts/windows/dreamina-profile-runner.ps1']);
const forbidden = /(?:^|\/)(?:tests?|fixtures|artifacts|test-results|runtime|output|logs|\.git|\.shensi|\.tmp[^/]*|generated|作品|笔记|secrets?|credentials?|tokens?|原始资料|_备份_不参与规则扫描|版本草案|废弃设定|回收站)(?:\/|$)|(?:^|\/)(?:\.env(?:\.[^/]*)?|secrets?|credentials?|tokens?|api[-_]?keys?)(?:\.[^/]*)?$|(?:^|\/)(?:test-|audit-|smoke-|benchmark-|run-.*real|configure-existing-|rebind-|bind-existing-)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$|(?:向天垂钓|三相之力|幻烬)|\.(?:log|pfx|p12|pem|key|cer|db|sqlite|docx|mp4|zip)$/iu;
function allowedPackagePath(value) {
  const file = String(value).replaceAll('\\', '/').replace(/^\.\//, '');
  if (/^node_modules\/@openai\/codex(?:-(?:win32|linux|darwin)-(?:x64|arm64))?\//u.test(file)) return !/(?:^|\/)(?:test|tests|examples|\.env|\.git)(?:\/|$)/iu.test(file) && !file.includes('../');
  if (file.includes('../') || forbidden.test(file)) return false;
  if (runtimeScripts.has(file)) return true;
  if (['server.mjs', 'index.html', 'package.json', 'release-build.json', 'update-config.json'].includes(file)) return true;
  if (file.startsWith('src/')) return /\.(?:mjs|cjs|js|css|html|json|svg|png|woff2?)$/i.test(file);
  if (file.startsWith('public/assets/')) return /^public\/assets\/shensi-[a-z-]+\.(?:png|ico|svg)$/i.test(file);
  if (file.startsWith('packaging/windows/desktop-app/')) return /\.(?:mjs|cjs|json|nsh)$/i.test(file);
  if (file.startsWith('packaging/bundled/')) return /(?:\.(?:md|json|yaml|yml|txt|js|mjs|py|png|svg)|\/LICENSE)$/i.test(file);
  if (file.startsWith('node_modules/undici/')) return !/(?:^|\/)(?:test|tests|benchmarks|examples)(?:\/|$)/i.test(file);
  return false;
}
async function verifyPackagedApplication(appRoot) {
  const rejected = [];
  let count = 0;
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relativePath = path.relative(appRoot, target).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) { rejected.push(relativePath); continue; }
      if (entry.isDirectory()) await visit(target);
      else { count++; if (!allowedPackagePath(relativePath)) rejected.push(relativePath); }
    }
  }
  await visit(appRoot);
  if (rejected.length) throw new Error(`安装包含非运行源码、个人作品或测试数据：${rejected.slice(0, 20).join('、')}`);
  return { ok: true, files: count };
}
const nonEmpty = (value) => String(value ?? '').trim().length > 0;
const allowedBlankDocumentContent = (id, document) => id === 'index-language-blacklist'
  && /当前没有项目级禁用词/u.test(String(document?.html || ''))
  && /当前没有项目级特别注意事项/u.test(String(document?.html || ''));
const stateContamination = (state, label) => {
  const issues = [];
  const collections = ['messages', 'histories', 'workspaceAssets', 'activities', 'trash', 'longFormJobs', 'isolatedBranches'];
  for (const key of collections) {
    const value = state?.[key];
    if (Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : Boolean(value)) issues.push(`${label}.${key}`);
  }
  if (nonEmpty(state?.currentCandidate) || state?.currentCandidateTarget || state?.currentCandidateMemoryUpdate) issues.push(`${label}.candidate`);
  for (const [id, document] of Object.entries(state?.documents || {})) {
    if (['html', 'markdown', 'text', 'content'].some((key) => nonEmpty(document?.[key])) && !allowedBlankDocumentContent(id, document)) issues.push(`${label}.documents.${id}`);
  }
  for (const conversation of state?.conversations || []) {
    if ((conversation?.messages || []).length || (conversation?.queue || []).length || (conversation?.attachments || []).length
      || nonEmpty(conversation?.currentCandidate) || conversation?.nativeAgentRun) issues.push(`${label}.conversations.${conversation?.id || 'unknown'}`);
  }
  const settings = state?.settings || {};
  for (const [key, value] of Object.entries(settings)) {
    if (/api.?key|password|secret|access.?token|refresh.?token/iu.test(key) && nonEmpty(value)) issues.push(`${label}.settings.${key}`);
  }
  if (nonEmpty(settings.workspacePath)) issues.push(`${label}.settings.workspacePath`);
  return issues;
};
async function verifyPackagedInitialState(appRoot) {
  const dataUrl = pathToFileURL(path.join(appRoot, 'src', 'data.js'));
  dataUrl.searchParams.set('package-audit', String(Date.now()));
  const data = await import(dataUrl.href);
  const states = [
    ['initial', data.createInitialState()],
    ['blank-project', data.createBlankProjectState({ name: '发布空作品' })],
    ['blank-notebook', data.createBlankNotebookState({ name: '发布空笔记' })],
  ];
  const issues = states.flatMap(([label, state]) => stateContamination(state, label));
  for (const [label, state] of states.slice(1)) {
    const seededDeliverables = Object.keys(state.documents || {}).filter((id) => /^(?:chapter-\d+|script-episode-\d+)$/u.test(id));
    if (seededDeliverables.length) issues.push(`${label}.seeded-deliverables:${seededDeliverables.join(',')}`);
  }
  if (issues.length) throw new Error(`安装包初始状态包含开发者作品、测试内容、凭据或运行状态：${issues.slice(0, 20).join('、')}`);
  return { ok: true, states: states.length };
}
module.exports = async function afterPack(context) {
  const appRoot = path.join(context.appOutDir, 'resources', 'app');
  await verifyPackagedApplication(appRoot);
  await verifyPackagedInitialState(appRoot);
  const { buildBundledShensiManifest, validateBundledShensi } = await import(pathToFileURL(path.join(context.packager.projectDir, 'src/server/bundled-shensi.mjs')));
  const sourceManifest = JSON.parse(await fs.readFile(path.join(context.packager.projectDir, 'packaging/bundled/shensi-bundle-manifest.json'), 'utf8'));
  const expected = sourceManifest.files.filter((file) => file.role !== 'reference-only' && allowedPackagePath(`packaging/bundled/skill/神思/${file.path}`));
  const actual = await buildBundledShensiManifest({ appRoot });
  if (JSON.stringify(actual.files) !== JSON.stringify(expected)) throw new Error('发布能力包与审查过的运行文件不一致；禁止自动接纳新增文件或缺失能力');
  await fs.writeFile(path.join(appRoot, 'packaging/bundled/shensi-bundle-manifest.json'), JSON.stringify(actual, null, 2));
  await validateBundledShensi({ appRoot });
};
module.exports.allowedPackagePath = allowedPackagePath;
module.exports.verifyPackagedApplication = verifyPackagedApplication;
module.exports.verifyPackagedInitialState = verifyPackagedInitialState;
