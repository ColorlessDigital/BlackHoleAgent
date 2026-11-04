import express from 'express';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { IS_WINDOWS, LLAMA_SERVER_EXECUTABLE } from '../../common/paths.js';

const execFileAsync = promisify(execFile);

export function createDialogRouter() {
  const router = express.Router();

  router.get('/dialog/select-workspace', async (_req, res) => {
    try {
      const selectedPath = await openDirectoryDialog('Select BlackHole workspace');
      if (!selectedPath) {
        return res.json({ canceled: true });
      }
      return res.json({ canceled: false, path: selectedPath });
    } catch (err) {
      return res.status(500).json({ error: `Workspace picker failed: ${err.message}` });
    }
  });

  router.get('/dialog/select-gguf', async (_req, res) => {
    try {
      const selectedPath = await openFileDialog({
        title: 'Select GGUF model file',
        windowsFilter: 'GGUF Models (*.gguf)|*.gguf',
        linuxFilter: '*.gguf'
      });
      if (!selectedPath) {
        return res.json({ canceled: true });
      }
      const filename = path.basename(selectedPath, '.gguf');
      const suggestedName = filename.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
      return res.json({ canceled: false, filePath: selectedPath, suggestedName });
    } catch (err) {
      return res.status(500).json({ error: `GGUF picker failed: ${err.message}` });
    }
  });

  router.get('/dialog/select-llama-server', async (_req, res) => {
    try {
      const selectedPath = await openFileDialog({
        title: `Select ${LLAMA_SERVER_EXECUTABLE}`,
        windowsFilter: 'llama-server.exe|llama-server.exe|Executable Files (*.exe)|*.exe',
        linuxFilter: '*'
      });
      if (!selectedPath) {
        return res.json({ canceled: true });
      }
      return res.json({ canceled: false, filePath: selectedPath });
    } catch (err) {
      return res.status(500).json({ error: `llama-server picker failed: ${err.message}` });
    }
  });

  return router;
}

async function openDirectoryDialog(title) {
  if (IS_WINDOWS) {
    return runPowerShellDialog([
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$f.Description = '${escapePowerShellString(title)}'`,
      "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"
    ].join('; '));
  }
  return runLinuxDialog({ mode: 'directory', title });
}

async function openFileDialog({ title, windowsFilter, linuxFilter }) {
  if (IS_WINDOWS) {
    return runPowerShellDialog([
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.OpenFileDialog',
      `$f.Title = '${escapePowerShellString(title)}'`,
      `$f.Filter = '${escapePowerShellString(windowsFilter)}'`,
      "if ($f.ShowDialog() -eq 'OK') { $f.FileName }"
    ].join('; '));
  }
  return runLinuxDialog({ mode: 'file', title, filter: linuxFilter });
}

async function runPowerShellDialog(script) {
  const powershell = findExecutable(['powershell.exe', 'pwsh.exe', 'powershell', 'pwsh']) || 'powershell';
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
    { encoding: 'utf8', windowsHide: true }
  );
  return stdout.trim();
}

async function runLinuxDialog({ mode, title, filter }) {
  const zenity = findExecutable(['zenity']);
  if (zenity) {
    const args = ['--file-selection', `--title=${title}`];
    if (mode === 'directory') args.push('--directory');
    if (mode === 'file' && filter && filter !== '*') args.push(`--file-filter=${filter}`);
    return runCancelableDialog(zenity, args);
  }

  const kdialog = findExecutable(['kdialog']);
  if (kdialog) {
    const home = os.homedir() || '.';
    const args = ['--title', title];
    if (mode === 'directory') {
      args.push('--getexistingdirectory', home);
    } else {
      args.push('--getopenfilename', home, filter && filter !== '*' ? `${filter}|Matching files` : '*|All files');
    }
    return runCancelableDialog(kdialog, args);
  }

  throw new Error('No GUI picker found. Install zenity or kdialog, or enter the path manually.');
}

async function runCancelableDialog(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8' });
    return stdout.trim();
  } catch (error) {
    if (error?.code === 1 || error?.code === 255) return '';
    throw error;
  }
}

function findExecutable(names) {
  const pathDirs = (process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = IS_WINDOWS ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const name of names) {
    if (path.isAbsolute(name) && fs.existsSync(name)) return name;
    for (const dir of pathDirs) {
      for (const ext of extensions) {
        const candidate = path.join(dir, name.endsWith(ext) ? name : `${name}${ext}`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

function escapePowerShellString(value) {
  return String(value || '').replace(/'/g, "''");
}
