import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = process.argv.find(arg => arg.startsWith('--sharp-module='))?.slice('--sharp-module='.length) || 'sharp';
const sharp = createRequire(import.meta.url)(modulePath);
const frames = [];
for (const name of ['demo-plan', 'demo-working', 'overview']) {
  frames.push(await sharp(path.join(root, 'docs/images', `${name}.png`)).resize(960, 600).ensureAlpha().raw().toBuffer());
}
const output = path.join(root, 'docs/images/workflow-demo.gif');
await sharp(Buffer.concat(frames), { raw: { width: 960, height: 1800, channels: 4, pageHeight: 600 } })
  .gif({ loop: 0, delay: [1800, 2000, 3200], effort: 7 }).toFile(output);
const metadata = await sharp(output, { animated: true }).metadata();
assert.equal(metadata.pages, 3);
assert.equal(metadata.pageHeight, 600);
assert.ok(fs.statSync(output).size > 10000);
console.log(JSON.stringify({ frames: 3, width: 960, frameHeight: 600, delaysMs: metadata.delay,
  liveModelRecording: false, personalData: false }));
