import { spawn, exec } from 'child_process';
import { resolveWorkspacePath } from './workspaceManager.js';

export function runTerminalCommand(command, options = {}) {
  const signal = options.abortSignal;
  signal?.throwIfAborted();
  const workspaceRoot = options.workspaceRoot || '';
  const cwd = options.cwd
    ? resolveWorkspacePath(options.cwd, workspaceRoot)
    : resolveWorkspacePath('.', workspaceRoot);
  const onOutput = options.onOutput || (() => {});
  const shell = getShellExecutable();
  const shellArgs = getShellArgs(command);
  const timeoutMs = options.timeout !== undefined ? options.timeout : 30000; // default 30s timeout
  const maxBuffer = options.maxBuffer !== undefined ? options.maxBuffer : 5 * 1024 * 1024; // default 5MB

  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, ...options.env, PAGER: 'cat' },
      windowsVerbatimArguments: process.platform === 'win32',
      windowsHide: process.platform === 'win32'
    });

    let output = '';
    let killedDueToSafety = false;

    const killProcess = (reason) => {
      if (killedDueToSafety) return;
      killedDueToSafety = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          exec(`C:\\Windows\\System32\\taskkill.exe /F /T /PID ${child.pid}`, { windowsHide: true }, () => {
            try { child.kill('SIGKILL'); } catch {}
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch (e) {
        console.error('Failed to kill child process:', e);
      }
      const text = `\n[Command Runner] Command terminated: ${reason}\n`;
      output += text;
      onOutput(text);
    };

    const timer = timeoutMs > 0 ? setTimeout(() => {
      killProcess(`Execution timed out after ${timeoutMs}ms`);
    }, timeoutMs) : null;
    const onAbort = () => killProcess('Stopped by user');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const checkBufferLimit = (chunk) => {
      output += chunk.toString();
      if (output.length > maxBuffer) {
        killProcess(`Buffer limit exceeded (${maxBuffer} bytes)`);
      } else {
        onOutput(chunk.toString());
      }
    };

    child.stdout.on('data', checkBufferLimit);
    child.stderr.on('data', checkBufferLimit);

    child.on('error', (error) => {
      cleanup();
      const text = `[spawn error] ${error.message}\n`;
      output += text;
      onOutput(text);
      resolve({ code: -1, output, cwd });
    });

    child.on('close', (code) => {
      cleanup();
      resolve({ code: killedDueToSafety ? -2 : code, output, cwd, aborted: Boolean(signal?.aborted) });
    });
  });
}

function getShellExecutable() {
  if (process.platform === 'win32') {
    return process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function getShellArgs(command) {
  if (process.platform === 'win32') {
    return ['/d', '/s', '/c', `"${command}"`];
  }
  const shell = getShellExecutable();
  if (shell.endsWith('fish')) return ['-c', command];
  return ['-lc', command];
}
