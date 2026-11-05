import fs from 'fs';
import path from 'path';
import { spawn, exec, execSync } from 'child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { streamChatCompletion } from './chatCompletionStream.js';
import { emitLog } from '../common/eventBus.js';
import {
  IS_WINDOWS,
  LLAMA_CPP_ROOT,
  LLAMA_SERVER_EXECUTABLE,
  MODEL_ROOT,
  PLATFORM_ARCH,
  PROJECT_ROOT,
  getDefaultLlamaServerPath
} from '../common/paths.js';
import { CONFIG_DIR } from '../config/configStore.js';

let llamaProcess = null;
let lastLaunch = null;

const GB = 1024 * 1024 * 1024;
const LARGE_MODEL_GB = 8;
const HUGE_MODEL_GB = 18;
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;
const DEFAULT_REQUEST_TIMEOUT_MS = 600000;

function findPidByPort(port) {
  return new Promise((resolve) => {
    const cmd = IS_WINDOWS ? getWindowsNetstatCommand() : getUnixPortPidCommand(port);
    exec(cmd, { timeout: 3000, windowsHide: IS_WINDOWS }, (err, stdout) => {
      if (err) {
        return resolve(null);
      }
      return resolve(IS_WINDOWS ? parseWindowsPortPid(stdout, port) : parseUnixPortPid(stdout));
    });
  });
}

function killPid(pid) {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      exec(`C:\\Windows\\System32\\taskkill.exe /F /PID ${pid}`, { windowsHide: true }, (err) => {
        if (!err) return resolve(true);
        exec(`taskkill /F /PID ${pid}`, { windowsHide: true }, (err2) => {
          if (!err2) return resolve(true);
          try {
            process.kill(pid);
            resolve(true);
          } catch {
            resolve(false);
          }
        });
      });
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process has already exited.
        }
        resolve(true);
      }, 500);
    } catch {
      resolve(false);
    }
  });
}

process.on('exit', () => {
  if (llamaProcess) {
    try {
        if (IS_WINDOWS) execSync(`C:\\Windows\\System32\\taskkill.exe /F /PID ${llamaProcess.pid}`, { windowsHide: true });
      else process.kill(llamaProcess.pid, 'SIGTERM');
    } catch {
      try {
          if (IS_WINDOWS) execSync(`taskkill /F /PID ${llamaProcess.pid}`, { windowsHide: true });
        else process.kill(llamaProcess.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(llamaProcess.pid);
        } catch {}
      }
    }
  }
});

export class LlamaCppRuntime {
  constructor(config) {
    this.config = config;
  }

  get baseUrl() {
    return this.config.llamaCppUrl || 'http://127.0.0.1:8080';
  }

  async listModels() {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`);
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      return (data.data || []).map((model) => ({
        id: `llamacpp:${model.id}`,
        name: model.id,
        runtime: 'llamacpp'
      }));
    } catch {
      return this.config.llamaCppModelPath
        ? [{ id: 'llamacpp:local-gguf', name: this.config.llamaCppModelPath, runtime: 'llamacpp' }]
        : [];
    }
  }

  async status() {
    const healthy = await this.isHealthy();
    const modelInfo = getModelInfo(this.config.llamaCppModelPath);
    return {
      healthy,
      baseUrl: this.baseUrl,
      serverPath: this.config.llamaCppServerPath || '',
      modelPath: this.config.llamaCppModelPath || '',
      modelInfo,
      managedProcessId: llamaProcess?.pid || null,
      lastLaunch
    };
  }

  async ensureServerRunning(overrides = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (await this.isHealthy()) return true;
    signal?.throwIfAborted();
    return this.startServer(overrides, { signal });
  }

  async preflightCheck(overrides = {}) {
    const merged = { ...this.config, ...overrides };
    const modelPath = merged.llamaCppModelPath;
    
    // 1. GGUF 모델 경로 검증
    if (!modelPath) {
      return { ok: false, type: 'MODEL_UNSELECTED', error: 'GGUF 모델 파일이 선택되지 않았습니다. 설정에서 먼저 AI 두뇌 모델(.gguf)을 지정해 주세요.' };
    }
    if (!fs.existsSync(modelPath)) {
      return { ok: false, type: 'MODEL_MISSING', error: `지정된 GGUF 모델 파일을 찾을 수 없습니다: ${modelPath}` };
    }

    // 2. 서버 실행파일 검증
    let serverPath = merged.llamaCppServerPath;
    if (!serverPath || !fs.existsSync(serverPath)) {
      const bundledPath = getDefaultLlamaServerPath();
      if (fs.existsSync(bundledPath)) {
        serverPath = bundledPath;
      } else {
        return { ok: false, type: 'SERVER_MISSING', error: `${LLAMA_SERVER_EXECUTABLE} 실행 파일을 찾을 수 없습니다. 내장 서버가 유실되었거나 경로 설정이 잘못되었습니다.` };
      }
    }

    // 3. 포트 충돌 및 기존 서버 검증
    try {
      const url = new URL(merged.llamaCppUrl || this.baseUrl);
      const port = url.port || '8080';
      const pid = await findPidByPort(port);
      if (pid) {
        const healthy = await this.isHealthy();
        if (healthy) {
          return { ok: true, type: 'ALREADY_RUNNING', warn: `포트 ${port}에서 이미 Llama.cpp 서버가 정상 구동 중입니다.` };
        } else {
          return { ok: false, type: 'PORT_COLLISION', error: `포트 ${port}가 이미 다른 프로그램(PID: ${pid})에 의해 사용 중입니다. 포트 설정을 변경하거나 해당 프로세스를 종료해 주세요.` };
        }
      }
    } catch (err) {
      return { ok: false, type: 'INVALID_CONFIG', error: `Llama.cpp URL 설정이 올바르지 않습니다: ${err.message}` };
    }

    return { ok: true, type: 'READY' };
  }

  async startServer(overrides = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const preflight = await this.preflightCheck(overrides);
    signal?.throwIfAborted();
    if (!preflight.ok) {
      throw new Error(preflight.error);
    }
    if (preflight.type === 'ALREADY_RUNNING') {
      emitLog('llama.cpp 서버가 이미 실행 중입니다.', 'info', { baseUrl: this.baseUrl });
      return true;
    }

    const merged = { ...this.config, ...overrides };
    let serverPath = merged.llamaCppServerPath;
    if (!serverPath || !fs.existsSync(serverPath)) {
      const bundledPath = getDefaultLlamaServerPath();
      if (fs.existsSync(bundledPath)) {
        serverPath = bundledPath;
      }
    }
    const modelPath = merged.llamaCppModelPath;
    validateRuntimePaths(serverPath, modelPath);

    const url = new URL(merged.llamaCppUrl || this.baseUrl);
    const host = url.hostname || '127.0.0.1';
    const port = url.port || '8080';
    const args = [
      '-m',
      modelPath,
      '--host',
      host,
      '--port',
      port,
      '--ctx-size',
      String(Number(merged.contextLimit) || 8192),
      '--batch-size',
      String(Number(merged.llamaCppBatch) || 512),
      '--parallel',
      String(Number(merged.llamaCppParallel) || 1)
    ];

    const threads = Number(merged.llamaCppThreads);
    if (threads > 0) args.push('--threads', String(threads));

    const gpuLayers = Number(merged.llamaCppGpuLayers);
    if (Number.isFinite(gpuLayers)) {
      args.push('--n-gpu-layers', String(gpuLayers));
    }

    const serverDir = path.dirname(serverPath);
    ensureExecutableBit(serverPath);
    const pathValue = [
      serverDir,
      path.join(serverDir, 'vulkan'),
      process.env.Path || process.env.PATH || ''
    ].filter(Boolean).join(path.delimiter);

    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const logPath = path.join(CONFIG_DIR, 'llama_server.log');
    let outFd;
    try {
      outFd = fs.openSync(logPath, 'w');
    } catch (err) {
      emitLog(`llama_server.log 파일 생성 실패: ${err.message}`, 'warning');
    }

    const child = spawn(serverPath, args, {
      cwd: path.dirname(serverPath),
      detached: true,
      stdio: outFd ? ['ignore', outFd, outFd] : 'ignore',
      windowsHide: process.platform === 'win32',
      env: {
        ...process.env,
        Path: pathValue,
        PATH: pathValue
      }
    });
    llamaProcess = child;
    let launchError = null;
    child.once('error', error => { launchError = error; });
    child.once('exit', () => { if (llamaProcess === child) llamaProcess = null; });

    if (outFd) {
      try {
        fs.closeSync(outFd);
      } catch (err) {
        // ignore
      }
    }

    llamaProcess.unref();
    const modelInfo = getModelInfo(modelPath);
    lastLaunch = {
      pid: llamaProcess.pid,
      serverPath,
      modelPath,
      modelInfo,
      args,
      startedAt: new Date().toISOString()
    };
    emitLog('llama.cpp 서버를 백그라운드에서 시작했습니다.', 'success', lastLaunch);

    const startupTimeoutMs = normalizeTimeoutMs(merged.llamaCppStartupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    const deadline = Date.now() + startupTimeoutMs;
    try {
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (await this.isHealthy()) return true;
        if (launchError || child.exitCode !== null || child.signalCode !== null) break;
        await delay(400, undefined, { signal });
      }
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) await killPid(child.pid);
      if (llamaProcess === child) llamaProcess = null;
      throw error;
    }
    if (child.pid && child.exitCode === null && child.signalCode === null) await killPid(child.pid);
    if (llamaProcess === child) llamaProcess = null;

    let logTail = '';
    if (fs.existsSync(logPath)) {
      try {
        const fullLog = fs.readFileSync(logPath, 'utf8');
        const lines = fullLog.split('\n');
        logTail = lines.slice(-15).join('\n');
      } catch (err) {
        logTail = `로그 읽기 실패: ${err.message}`;
      }
    }
    if (launchError) logTail = `${launchError.code || 'SPAWN_FAILED'}: ${launchError.message}\n${logTail}`;

    const isGpuOom = logTail.includes('OutOfDeviceMemory') || 
                      logTail.includes('failed to allocate Vulkan') || 
                      logTail.includes('unable to allocate Vulkan') ||
                      logTail.includes('ErrorOutOfDeviceMemory');

    if (isGpuOom && gpuLayers > 0) {
      emitLog('Vulkan VRAM 부족으로 모델 로딩에 실패했습니다. CPU 모드로 자동 전환하여 재기동합니다...', 'warning', { logTail });
      return this.startServer({ ...overrides, llamaCppGpuLayers: 0 }, { signal });
    }

    emitLog(`llama.cpp 서버가 시작되지 않았거나 비정상 종료되었습니다.\n\n[최근 로그]:\n${logTail}`, 'error', {
      exitCode: child.exitCode,
      logPath
    });
    return false;
  }

  async stopServer() {
    let killed = false;
    if (llamaProcess) {
      try {
        await killPid(llamaProcess.pid);
        killed = true;
      } catch {
        // ignore
      }
      llamaProcess = null;
    }

    if (killed) {
      emitLog('llama.cpp 서버 프로세스를 중지했습니다.', 'warning');
      return true;
    }
    return false;
  }

  async isHealthy() {
    const serverPath = this.config.llamaCppServerPath;
    const modelPath = this.config.llamaCppModelPath;
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(900) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async chatStream({ model, messages, maxTokens, temperature, grammar, signal, onReasoning, allowIncomplete }, onChunk) {
    const ready = await this.ensureServerRunning({}, { signal });
    signal?.throwIfAborted();
    if (!ready) throw new Error(`llama.cpp 서버가 준비되지 않았습니다. ${LLAMA_SERVER_EXECUTABLE}와 GGUF 모델 경로를 확인하세요.`);
    const modelName = model.replace(/^llamacpp:/, '') || 'local-gguf';
    const requestTimeoutMs = normalizeTimeoutMs(this.config.llamaCppRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const requestBody = {
      model: modelName,
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature
    };
    if (grammar && typeof grammar === 'string') {
      requestBody.grammar = grammar;
    }
    return streamChatCompletion({
      url: `${this.baseUrl}/v1/chat/completions`,
      headers: { 'Content-Type': 'application/json' },
      body: requestBody, timeoutMs: requestTimeoutMs, signal, provider: 'llamacpp', model: modelName,
      onReasoning, allowIncomplete
    }, onChunk);
  }
}

export async function stopLlamaCppRuntime() {
  if (llamaProcess) {
    await killPid(llamaProcess.pid);
    llamaProcess = null;
  }
}

export function discoverLlamaCppCandidates() {
  const candidates = [
    getDefaultLlamaServerPath(),
    path.join(LLAMA_CPP_ROOT, LLAMA_SERVER_EXECUTABLE),
    path.join(LLAMA_CPP_ROOT, PLATFORM_ARCH, LLAMA_SERVER_EXECUTABLE),
    path.join(PROJECT_ROOT, 'resources', 'llama.cpp', LLAMA_SERVER_EXECUTABLE),
    path.join(PROJECT_ROOT, 'resources', 'llama.cpp', PLATFORM_ARCH, LLAMA_SERVER_EXECUTABLE),
    ...(IS_WINDOWS
      ? [
          'C:\\Program Files\\llama.cpp\\llama-server.exe',
          'C:\\Program Files\\llama.cpp\\bin\\llama-server.exe'
        ]
      : [
          '/usr/local/bin/llama-server',
          '/usr/bin/llama-server',
          '/opt/llama.cpp/llama-server',
          '/opt/llama.cpp/bin/llama-server'
        ])
  ];
  return uniqueExistingPaths(candidates)
    .map((candidate) => ({
      path: candidate,
      directory: path.dirname(candidate)
    }));
}

export function discoverGgufModels(searchRoots = [
  MODEL_ROOT,
  path.join(PROJECT_ROOT, 'models'),
  ...(IS_WINDOWS
    ? ['D:\\BlackHole\\.models']
    : [
        path.join(process.env.HOME || '', 'models'),
        path.join(process.env.HOME || '', '.models'),
        path.join(process.env.HOME || '', 'Downloads'),
        '/opt/blackhole/models'
      ])
]) {
  const results = [];
  const seenModels = new Set();
  for (const root of uniqueExistingPaths(searchRoots)) {
    try {
      if (!fs.statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    walkForGguf(root, results, 30, seenModels);
  }
  return results;
}

function walkForGguf(current, results, limit, seenModels) {
  if (results.length >= limit) return;
  let entries = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= limit) return;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkForGguf(absolute, results, limit, seenModels);
    } else if (entry.name.toLowerCase().endsWith('.gguf')) {
      const key = pathKey(absolute);
      if (seenModels.has(key)) continue;
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch {
        continue;
      }
      seenModels.add(key);
      results.push({
        path: absolute,
        name: entry.name,
        sizeGB: Number((stat.size / 1024 / 1024 / 1024).toFixed(2))
      });
    }
  }
}

function uniqueExistingPaths(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const normalized = path.resolve(candidate);
    const key = pathKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function pathKey(targetPath) {
  let resolved = path.resolve(targetPath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Fall back to the resolved path if the target disappears between checks.
  }
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function validateRuntimePaths(serverPath, modelPath) {
  if (!serverPath || !fs.existsSync(serverPath)) {
    throw new Error(`${LLAMA_SERVER_EXECUTABLE} 경로를 찾을 수 없습니다: ${serverPath || '(empty)'}`);
  }
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error(`GGUF 모델 경로를 찾을 수 없습니다: ${modelPath || '(empty)'}`);
  }
}

function getWindowsNetstatCommand() {
  const netstatPath = 'C:\\Windows\\System32\\netstat.exe';
  return fs.existsSync(netstatPath) ? `"${netstatPath}" -ano` : 'netstat -ano';
}

function getUnixPortPidCommand(port) {
  return [
    `command -v lsof >/dev/null 2>&1 && lsof -tiTCP:${port} -sTCP:LISTEN`,
    `command -v fuser >/dev/null 2>&1 && fuser ${port}/tcp 2>/dev/null`,
    `command -v ss >/dev/null 2>&1 && ss -ltnp 'sport = :${port}' 2>/dev/null`
  ].join(' || ');
}

function parseWindowsPortPid(stdout, port) {
  const lines = String(stdout || '').split('\n');
  const searchStr = `:${port}`;
  for (const line of lines) {
    if (line.includes(searchStr) && line.includes('LISTENING')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (!Number.isNaN(pid) && pid > 0) return pid;
    }
  }
  return null;
}

function parseUnixPortPid(stdout) {
  const text = String(stdout || '').trim();
  const directPid = parseInt(text.split(/\s+/)[0], 10);
  if (!Number.isNaN(directPid) && directPid > 0) return directPid;
  const pidMatch = text.match(/pid=(\d+)/);
  if (pidMatch) return Number(pidMatch[1]);
  return null;
}

function getModelInfo(modelPath) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    return null;
  }

  try {
    const stat = fs.statSync(modelPath);
    const sizeGB = stat.size / GB;
    return {
      path: modelPath,
      name: path.basename(modelPath),
      sizeGB: Number(sizeGB.toFixed(2)),
      tier: sizeGB >= HUGE_MODEL_GB ? 'huge' : sizeGB >= LARGE_MODEL_GB ? 'large' : 'standard'
    };
  } catch {
    return null;
  }
}

function normalizeTimeoutMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, 15000), 900000);
}

function ensureExecutableBit(filePath) {
  if (IS_WINDOWS || !filePath || !fs.existsSync(filePath)) return;
  try {
    const stat = fs.statSync(filePath);
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(filePath, stat.mode | 0o755);
    }
  } catch {
    // The process may not own a system-installed llama-server. Spawn will report if it is unusable.
  }
}
