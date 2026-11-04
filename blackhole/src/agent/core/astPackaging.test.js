import assert from 'node:assert/strict';
import test from 'node:test';
import includeRuntimeFile from '../../../build/include-runtime-files.cjs';

test('packaging retains TypeScript standard libraries needed by runtime semantic analysis', () => {
  assert.equal(includeRuntimeFile('D:\\app\\node_modules\\typescript\\lib\\lib.es5.d.ts'), true);
  assert.equal(includeRuntimeFile('/app/node_modules/typescript/lib/lib.d.ts'), true);
  assert.equal(includeRuntimeFile('/app/node_modules/other/package.d.ts'), false);
  assert.equal(includeRuntimeFile('/app/node_modules/typescript/lib/typescript.js'), false);
});
