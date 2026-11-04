import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuildInfo } from './release-metadata.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = argument('output');
if (!output) throw new Error('--output must name the BUILDINFO.json destination.');
const info = createBuildInfo(projectRoot, argument('platform'));
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
