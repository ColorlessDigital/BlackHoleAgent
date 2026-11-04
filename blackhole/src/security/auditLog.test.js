import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';

test('audit bounds nested results and rotates before an append would exceed the file budget', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.BLACKHOLE_DATA_DIR = root;
  process.env.BLACKHOLE_AUDIT_MAX_BYTES = '4096';
  const { writeAudit } = await import('./auditLog.js');
  const result = Array.from({ length: 1000 }, (_, i) => ({ name: String(i), children: [{ content: '\u0000'.repeat(5000) }] }));
  for (let i = 0; i < 10; i++) writeAudit({ phase: 'executed', action: { id: String(i), capability: 'list_dir' }, result });
  const files = fs.readdirSync(root);
  assert.ok(files.includes('audit.1.log'));
  assert.ok(files.length <= 6);
  for (const file of files) {
    assert.ok(fs.statSync(path.join(root, file)).size <= 4096);
    for (const line of fs.readFileSync(path.join(root, file), 'utf8').trim().split('\n')) assert.equal(JSON.parse(line).phase, 'executed');
  }
});
