// Release parity checker: Windows vs Linux artifacts drift report.
// Read-only. Exit 0 with report JSON; exit 2 when drift exceeds thresholds.
// Usage: node scripts/check-release-parity.js [--json]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareSourceIdentity } from './release-parity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PROJECT_ROOT, '..');
const jsonOnly = process.argv.includes('--json');

function statArtifact(dir, names) {
  for (const name of names) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) {
      try {
        const st = fs.statSync(full);
        return { name, path: full, size: st.size, mtime: st.mtime.toISOString() };
      } catch {
        return { name, path: full, size: -1, mtime: null };
      }
    }
  }
  // Fall back: newest matching extension.
  try {
    const files = fs.readdirSync(dir);
    const ext = names[0].slice(names[0].lastIndexOf('.'));
    const match = files
      .filter((f) => f.endsWith(ext))
      .map((f) => ({ f, st: fs.statSync(path.join(dir, f)) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
    if (match) return { name: match.f, path: path.join(dir, match.f), size: match.st.size, mtime: match.st.mtime.toISOString() };
  } catch {}
  return null;
}

function readBuildInfo(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'BUILDINFO.json'), 'utf-8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

const windowsDir = path.join(REPO_ROOT, 'windows');
const linuxDir = path.join(REPO_ROOT, 'linux');
const windowsExe = statArtifact(windowsDir, ['BlackHole-Setup.exe', 'blackhole.exe']);
const linuxPkg = statArtifact(linuxDir, [`BlackHole-${JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version}-${process.arch}.tar.gz`]);
const windowsInfo = readBuildInfo(windowsDir);
const linuxInfo = readBuildInfo(linuxDir);

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
} catch {}

const findings = [];
findings.push(...compareSourceIdentity(windowsInfo, linuxInfo));
if (!windowsExe) findings.push('windows installer artifact missing');
if (!linuxPkg) findings.push('linux package artifact missing');
if (!windowsInfo) findings.push('windows/BUILDINFO.json missing — rebuild Windows with current sign-release.ps1');
if (!linuxInfo) findings.push('linux/BUILDINFO.json missing — rebuild Kali with updated build-kali-release.sh');
if (windowsExe && linuxPkg) {
  const ageDays = Math.abs(new Date(windowsExe.mtime) - new Date(linuxPkg.mtime)) / 86400000;
  if (ageDays > 14) findings.push(`artifact age drift: windows ${windowsExe.mtime} vs linux ${linuxPkg.mtime} (${ageDays.toFixed(0)} days)`);
}
if (windowsInfo && linuxInfo && windowsInfo.gitSha && linuxInfo.gitSha && windowsInfo.gitSha !== linuxInfo.gitSha) {
  findings.push(`git SHA drift: windows ${windowsInfo.gitSha} vs linux ${linuxInfo.gitSha}`);
}

const report = {
  ok: findings.length === 0,
  version: pkg?.version || null,
  windows: { artifact: windowsExe, buildInfo: windowsInfo },
  linux: { artifact: linuxPkg, buildInfo: linuxInfo },
  findings,
  rebuild: {
    windows: 'npm run build:exe (Windows)',
    linux: 'npm run build:kali (Kali)'
  }
};

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== BlackHole release parity ===');
  console.log(`version: ${report.version}`);
  console.log(`windows: ${windowsExe ? `${windowsExe.name} ${(windowsExe.size / 1048576).toFixed(0)}MB ${windowsExe.mtime}` : 'MISSING'}`);
  console.log(`linux:   ${linuxPkg ? `${linuxPkg.name} ${(linuxPkg.size / 1048576).toFixed(0)}MB ${linuxPkg.mtime}` : 'MISSING'}`);
  console.log(`windows BUILDINFO: ${windowsInfo ? `gitSha=${windowsInfo.gitSha}` : 'MISSING'}`);
  console.log(`linux BUILDINFO:   ${linuxInfo ? `gitSha=${linuxInfo.gitSha}` : 'MISSING'}`);
  if (findings.length === 0) console.log('OK: no drift detected.');
  else {
    console.log('DRIFT:');
    for (const f of findings) console.log(`  - ${f}`);
  }
}
process.exit(findings.length === 0 ? 0 : 2);
