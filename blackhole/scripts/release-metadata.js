import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function fingerprintFiles(root, files) {
  const hash = crypto.createHash('sha256');
  for (const relative of [...files].sort()) {
    let content = fs.readFileSync(path.join(root, relative));
    if (/\.(?:js|cjs|mjs|jsx|ts|tsx|json|css|html|sh|ps1|ya?ml|md)$/.test(relative)) {
      content = Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'));
    }
    hash.update(`${relative.replaceAll('\\', '/')}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest('hex');
}

export function createBuildInfo(projectRoot, platform = process.platform) {
  const repoRoot = path.dirname(projectRoot);
  const files = [];
  function collect(relative) {
    const full = path.join(repoRoot, relative);
    if (!fs.existsSync(full)) throw new Error(`Missing build input: ${relative}`);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full).sort()) collect(`${relative}/${entry}`);
    } else if (stat.isFile()) files.push(relative);
  }
  for (const relative of [
    'blackhole/src', 'blackhole/scripts', 'blackhole/build',
    'blackhole/frontend/src', 'blackhole/frontend/public',
    'vscode-blackhole/src', 'vscode-blackhole/resources', 'vscode-blackhole/test',
    'blackhole/package.json', 'blackhole/package-lock.json', 'vscode-blackhole/package.json', 'vscode-blackhole/package-lock.json'
  ]) collect(relative);
  for (const directory of ['blackhole/frontend', 'vscode-blackhole']) {
    for (const name of fs.readdirSync(path.join(repoRoot, directory))) {
      if (/\.(?:json|js|ts|html)$/.test(name)) collect(`${directory}/${name}`);
    }
  }
  const git = args => {
    const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const status = git(['status', '--porcelain']);
  return {
    builtAt: new Date().toISOString(), platform, arch: process.arch, version: pkg.version,
    gitSha: git(['rev-parse', '--short', 'HEAD']) || 'unknown',
    gitDirty: status === null ? null : Boolean(status),
    sourceHash: fingerprintFiles(repoRoot, [...new Set(files)]),
    sourceHashAlgorithm: 'sha256-normalized-v1',
    nodeVersion: process.version,
    electronVersion: pkg.devDependencies.electron,
    builderVersion: pkg.devDependencies['electron-builder']
  };
}
