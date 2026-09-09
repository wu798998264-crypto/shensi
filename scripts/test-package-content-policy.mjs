import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { validateBundledShensi } from '../src/server/bundled-shensi.mjs';
import { createInitialState, createBlankProjectState, createBlankNotebookState } from '../src/data.js';
const packagePolicy = createRequire(import.meta.url)('./package-content-policy.cjs');
const { allowedPackagePath } = packagePolicy;
for (const file of ['server.mjs', 'src/server/media-generation-worker.mjs', 'scripts/windows/dreamina-profile-runner.ps1', 'scripts/update-installer-helper.mjs', 'packaging/bundled/skill/神思/神思模块/任务路由模块.md', 'public/assets/shensi-logo.png']) assert.equal(allowedPackagePath(file), true, file);
for (const file of ['scripts/test-example.mjs', 'scripts/audit-private.mjs', 'runtime/works.json', 'src/作品/第一章.md', 'packaging/bundled/skill/神思/原始资料/正文.md', 'packaging/bundled/向天垂钓.md', 'public/assets/private-photo.png', 'src/test-results/screenshot.png', 'shensi-codesign.pfx']) assert.equal(allowedPackagePath(file), false, file);
for (const file of ['src/private.spec.js', 'src/secrets/provider.json', 'src/credentials.json', 'src/tokens/session.json', 'src/.env.production', 'src/api-keys.json']) assert.equal(allowedPackagePath(file), false, file);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const initial = createInitialState();
assert.deepEqual(initial.messages, []);
assert.deepEqual(initial.histories, {});
assert.equal(initial.currentCandidate, '');
assert.ok(Object.values(initial.documents).every((document) => !document.html && !document.markdown));
assert.equal(initial.settings.activeTextAgentConnectionId, "text-public-agent");
assert.equal(initial.documents["outline-series"].moduleId, "outline", "目录别名不能改变文档所属板块");
assert.equal(initial.documents["report-compile"].derived, true);
const productionData = await readFile(new URL('../src/data.js', import.meta.url), 'utf8');
assert.doesNotMatch(productionData, /陆沉|简宁|03:17|第一次误判|const manuscript =/u);
const policySource = await readFile(new URL('../src/context-content-policy.js', import.meta.url), 'utf8');
assert.doesNotMatch(policySource, /陆沉|简宁|03:17|第一次误判/u);
assert.equal(pkg.build.afterPack, 'scripts/package-content-policy.cjs');
assert.ok(!pkg.build.files.includes('scripts/**/*'));
assert.ok(!pkg.build.files.includes('packaging/**/*'));
for (const state of [createBlankProjectState({ name: '空作品' }), createBlankNotebookState({ name: '空笔记' })]) {
  assert.ok(!Object.keys(state.documents).some((id) => /^chapter-|^script-episode-/u.test(id)), 'new installation must not create personal chapter fixtures');
}
const staging = await mkdtemp(join(tmpdir(), 'shensi-clean-package-'));
try {
  const sourceRoot = process.cwd();
  const appRoot = join(staging, 'resources', 'app');
  const bundleManifestPath = 'packaging/bundled/shensi-bundle-manifest.json';
  const manifest = JSON.parse(await readFile(join(sourceRoot, bundleManifestPath), 'utf8'));
  const approvedFiles = manifest.files.filter((file) => file.role !== 'reference-only').map((file) => `packaging/bundled/skill/神思/${file.path}`);
  await cp(join(sourceRoot, 'src'), join(appRoot, 'src'), { recursive: true });
  for (const file of [...approvedFiles, bundleManifestPath]) {
    assert.ok(allowedPackagePath(file), `approved runtime resource: ${file}`);
    const destination = join(appRoot, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, file), destination);
  }
  await packagePolicy({ appOutDir: staging, packager: { projectDir: sourceRoot } });
  const verified = await validateBundledShensi({ appRoot });
  assert.equal(verified.fileCount, approvedFiles.length);
  assert.ok(verified.fileCount < manifest.fileCount, 'reference-only works must be absent from release');
  const contaminatedApp = join(staging, 'contaminated-app');
  await mkdir(join(contaminatedApp, 'src'), { recursive: true });
  await writeFile(join(contaminatedApp, 'package.json'), '{"type":"module"}', 'utf8');
  await writeFile(join(contaminatedApp, 'src', 'data.js'), `
    export const createInitialState = () => ({ messages: [{ content: "开发者测试作品正文" }], settings: {} });
    export const createBlankProjectState = () => ({ documents: { "chapter-1": { markdown: "开发者测试作品正文" } }, settings: {} });
    export const createBlankNotebookState = () => ({ settings: { apiKey: "test-secret", workspacePath: "C:/developer/private" } });
  `, 'utf8');
  await assert.rejects(packagePolicy.verifyPackagedInitialState(contaminatedApp), /开发者作品、测试内容、凭据或运行状态/u,
    '打包钩子必须主动拒绝被误植入的开发者作品、测试状态、密钥和本机路径');
  console.log(`Clean staged bundle integrity passed (${verified.fileCount} runtime files; no original/reference-only files)`);
} finally {
  const rel = relative(resolve(tmpdir()), resolve(staging));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(staging, { recursive: true, force: true });
}
console.log('Package content allowlist and blank-workspace regression passed');
