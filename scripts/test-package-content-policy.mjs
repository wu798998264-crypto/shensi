import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { validateBundledShensi } from '../src/server/bundled-shensi.mjs';
import { createInitialState, createBlankProjectState, createBlankNotebookState } from '../src/data.js';
const packagePolicy = createRequire(import.meta.url)('./package-content-policy.cjs');
const { allowedPackagePath } = packagePolicy;
for (const file of ['server.mjs', 'src/server/media-generation-worker.mjs', 'scripts/windows/dreamina-profile-runner.ps1', 'scripts/update-installer-helper.mjs', 'packaging/bundled/skill/神思/神思模块/任务路由模块.md', 'public/assets/shensi-logo.png']) assert.equal(allowedPackagePath(file), true, file);
for (const file of ['scripts/test-example.mjs', 'scripts/audit-private.mjs', 'runtime/works.json', 'src/作品/第一章.md', 'packaging/bundled/skill/神思/原始资料/正文.md', 'packaging/bundled/向天垂钓.md', 'public/assets/private-photo.png', 'src/test-results/screenshot.png', 'shensi-codesign.pfx']) assert.equal(allowedPackagePath(file), false, file);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const initial = createInitialState();
assert.deepEqual(initial.messages, []);
assert.deepEqual(initial.histories, {});
assert.equal(initial.currentCandidate, '');
assert.ok(Object.values(initial.documents).every((document) => !document.html && !document.markdown));
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
  console.log(`Clean staged bundle integrity passed (${verified.fileCount} runtime files; no original/reference-only files)`);
} finally {
  const rel = relative(resolve(tmpdir()), resolve(staging));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(staging, { recursive: true, force: true });
}
console.log('Package content allowlist and blank-workspace regression passed');
