import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fingerprintFiles } from './release-metadata.js';
import { compareSourceIdentity } from './release-parity.js';
import linuxConfig from '../build/linux.cjs';
import pkg from '../package.json' with { type: 'json' };

test('source fingerprint ignores checkout line endings but detects code changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'entry.js'), 'export const value = 1;\r\n');
  const original = fingerprintFiles(root, ['entry.js']);
  fs.writeFileSync(path.join(root, 'entry.js'), 'export const value = 1;\n');
  assert.equal(fingerprintFiles(root, ['entry.js']), original);
  fs.writeFileSync(path.join(root, 'entry.js'), 'export const value = 2;\n');
  assert.notEqual(fingerprintFiles(root, ['entry.js']), original);
});

test('Linux packaging retains shared app configuration and only stages Linux resources', () => {
  assert.deepEqual(linuxConfig.files, pkg.build.files);
  assert.equal(linuxConfig.onNodeModuleFile, pkg.build.onNodeModuleFile);
  assert.equal(linuxConfig.extraResources[0].from, 'resources/llama.cpp/linux-${arch}');
  assert.equal(linuxConfig.extraResources.some(entry => typeof entry === 'string' || entry.from === 'resources/llama.cpp'), false);
});

test('Windows packaging requires signing before embedding the executable in installers', () => {
  assert.equal(pkg.build.win.forceCodeSigning, true);
  assert.equal(pkg.build.win.signtoolOptions.certificateSubjectName, 'BlackHole Publisher');
  assert.deepEqual(pkg.build.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
});

test('release parity requires matching source fingerprints even on the same Git commit', () => {
  const info = { gitSha: 'same', sourceHash: 'a', sourceHashAlgorithm: 'sha256-normalized-v1' };
  assert.deepEqual(compareSourceIdentity(info, { ...info }), []);
  assert.match(compareSourceIdentity(info, { ...info, sourceHash: 'b' })[0], /source drift/);
  assert.match(compareSourceIdentity({ gitSha: 'same' }, info)[0], /fingerprint missing/);
  assert.match(compareSourceIdentity(info, { ...info, sourceHashAlgorithm: 'other' })[0], /algorithms differ/);
});
