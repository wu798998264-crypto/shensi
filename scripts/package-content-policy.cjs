const fs = require('node:fs/promises');
const path = require('node:path');

const runtimeScripts = new Set(['scripts/launcher.mjs', 'scripts/update-installer-helper.mjs', 'scripts/windows/dreamina-profile-runner.ps1']);
const forbidden = /(?:^|\/)(?:tests?|fixtures|artifacts|test-results|runtime|output|logs|\.git|\.shensi|\.tmp[^/]*|generated|作品|笔记|原始资料|_备份_不参与规则扫描|版本草案|废弃设定|回收站)(?:\/|$)|(?:^|\/)(?:test-|audit-|smoke-|benchmark-|run-.*real|configure-existing-|rebind-|bind-existing-)|(?:向天垂钓|三相之力|幻烬)|\.(?:log|pfx|p12|pem|key|cer|db|sqlite|docx|mp4|zip)$/iu;
function allowedPackagePath(value) {
  const file = String(value).replaceAll('\\', '/').replace(/^\.\//, '');
  if (file.includes('../') || forbidden.test(file)) return false;
  if (runtimeScripts.has(file)) return true;
  if (['server.mjs', 'index.html', 'package.json', 'release-build.json', 'update-config.json'].includes(file)) return true;
  if (file.startsWith('src/')) return /\.(?:mjs|cjs|js|css|html|json|svg|png|woff2?)$/i.test(file);
  if (file.startsWith('public/assets/')) return /^public\/assets\/shensi-[a-z-]+\.(?:png|ico|svg)$/i.test(file);
  if (file.startsWith('packaging/windows/desktop-app/')) return /\.(?:mjs|cjs|json|nsh)$/i.test(file);
  if (file.startsWith('packaging/bundled/')) return /\.(?:md|json|yaml|yml|txt|js|mjs|py)$/i.test(file);
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
module.exports = async function afterPack(context) {
  const appRoot = path.join(context.appOutDir, 'resources', 'app');
  await verifyPackagedApplication(appRoot);
};
module.exports.allowedPackagePath = allowedPackagePath;
module.exports.verifyPackagedApplication = verifyPackagedApplication;
