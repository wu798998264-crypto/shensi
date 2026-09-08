import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createInitialState, createBlankProjectState, createBlankNotebookState } from '../src/data.js';
const { allowedPackagePath } = createRequire(import.meta.url)('./package-content-policy.cjs');
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
assert.equal(pkg.build.afterPack, 'scripts/package-content-policy.cjs');
assert.ok(!pkg.build.files.includes('scripts/**/*'));
assert.ok(!pkg.build.files.includes('packaging/**/*'));
for (const state of [createBlankProjectState({ name: '空作品' }), createBlankNotebookState({ name: '空笔记' })]) {
  assert.ok(!Object.keys(state.documents).some((id) => /^chapter-|^script-episode-/u.test(id)), 'new installation must not create personal chapter fixtures');
}
console.log('Package content allowlist and blank-workspace regression passed');
