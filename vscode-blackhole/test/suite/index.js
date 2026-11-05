const assert = require('assert');
const http = require('http');
const { randomInt } = require('crypto');
const vscode = require('vscode');

module.exports.run = async function run() {
  const requests = [];
  const { server, baseUrl } = await startMockBlackHoleApi(requests);

  try {
    await vscode.workspace.getConfiguration('blackhole').update('apiBaseUrl', baseUrl, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('blackhole').update('autoSyncWorkspace', true, vscode.ConfigurationTarget.Workspace);
    const extension = vscode.extensions.getExtension('kge7.vscode-blackhole')
      || vscode.extensions.all.find(item => item.packageJSON?.name === 'vscode-blackhole');
    assert.ok(extension, 'BlackHole extension was not loaded by VS Code.');
    await extension.activate();

    await assertCommandsRegistered();
    await assertConnectsAndSyncs(requests);
    await assertResumeCheckpointStreams(requests);
    await assertSelectionCommandsRun();
    await assertNativeInlineEditRuns(requests);
    await assertManualCompletionRuns(requests);
    await assertDiffReviewCommandsRun(requests);
    await assertAgentTaskCommandRuns(requests);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};

async function assertCommandsRegistered() {
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'blackhole.focusChat',
    'blackhole.connect',
    'blackhole.setWorkspace',
    'blackhole.addToContext',
    'blackhole.askAboutSelection',
    'blackhole.resumeLatest',
    'blackhole.explainSelection',
    'blackhole.inlineEdit',
    'blackhole.fixDiagnostics',
    'blackhole.generateCompletion',
    'blackhole.reviewAgentDiffs',
    'blackhole.acceptDiffTransaction',
    'blackhole.rejectDiffTransaction',
    'blackhole.rollbackDiffTransaction',
    'blackhole.runAgentTask',
    'blackhole.runAgentTaskWithSelection'
  ]) {
    assert.ok(commands.includes(command), `missing command: ${command}`);
  }
}

async function assertConnectsAndSyncs(requests) {
  await vscode.commands.executeCommand('blackhole.connect');
  await vscode.commands.executeCommand('blackhole.setWorkspace');

  assert.ok(requests.some(req => req.method === 'GET' && req.url === '/api/bootstrap'), 'bootstrap was not called');
  assert.ok(requests.some(req => req.method === 'POST' && req.url === '/api/workspace'), 'workspace sync was not called');
}

async function assertResumeCheckpointStreams(requests) {
  await vscode.commands.executeCommand('blackhole.resumeLatest');
  assert.ok(
    requests.some(req => req.method === 'POST' && req.url === '/api/chat/resume-checkpoint'),
    'resume checkpoint stream was not called'
  );
}

async function assertSelectionCommandsRun() {
  const document = await vscode.workspace.openTextDocument({
    language: 'javascript',
    content: 'export function multiply(a, b) {\n  return a * b;\n}\n'
  });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 2, 1);

  await vscode.commands.executeCommand('blackhole.addToContext');
  await vscode.commands.executeCommand('blackhole.askAboutSelection');
  await vscode.commands.executeCommand('blackhole.explainSelection');
}

async function assertNativeInlineEditRuns(requests) {
  const document = await vscode.workspace.openTextDocument({
    language: 'javascript',
    content: 'export function multiply(a, b) {\n  return a * b;\n}\n'
  });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 2, 1);

  await vscode.commands.executeCommand('blackhole.inlineEdit', 'make the result include one extra point');
  assert.ok(
    document.getText().includes('return a * b + 1;'),
    'inline edit did not apply replacement code'
  );
  assert.ok(
    requests.some(req => req.method === 'POST' && req.url === '/api/ide/inline-edit'),
    'inline edit endpoint was not called'
  );
}

async function assertManualCompletionRuns(requests) {
  const document = await vscode.workspace.openTextDocument({
    language: 'javascript',
    content: 'export function subtract(a, b) {\n  '
  });
  const editor = await vscode.window.showTextDocument(document);
  const lastLine = document.lineAt(document.lineCount - 1);
  editor.selection = new vscode.Selection(lastLine.range.end, lastLine.range.end);

  await vscode.commands.executeCommand('blackhole.generateCompletion');
  assert.ok(
    document.getText().includes('return a - b;'),
    'manual completion did not insert suggestion'
  );
  assert.ok(
    requests.some(req => req.method === 'POST' && req.url === '/api/ide/autocomplete'),
    'autocomplete endpoint was not called'
  );
}

async function assertDiffReviewCommandsRun(requests) {
  await vscode.commands.executeCommand('blackhole.reviewAgentDiffs', 'diff-1');
  await vscode.commands.executeCommand('blackhole.acceptDiffTransaction', 'diff-1');
  await vscode.commands.executeCommand('blackhole.rejectDiffTransaction', 'diff-2');
  await vscode.commands.executeCommand('blackhole.rollbackDiffTransaction', 'diff-1');

  assert.ok(
    requests.some(req => req.method === 'GET' && req.url === '/api/diff/transactions?limit=30'),
    'diff transaction list endpoint was not called'
  );
  assert.ok(
    requests.some(req => req.method === 'POST' && req.url === '/api/diff/transactions/diff-1/accept'),
    'diff accept endpoint was not called'
  );
  assert.ok(
    requests.some(req => req.method === 'POST' && req.url === '/api/diff/transactions/diff-2/reject'),
    'diff reject endpoint was not called'
  );
  assert.ok(
    requests.some(req => req.method === 'POST' && req.url === '/api/diff/transactions/diff-1/rollback'),
    'diff rollback endpoint was not called'
  );
}

async function assertAgentTaskCommandRuns(requests) {
  const document = await vscode.workspace.openTextDocument({
    language: 'javascript',
    content: 'export function divide(a, b) {\n  return a / b;\n}\n'
  });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 2, 1);

  await vscode.commands.executeCommand('blackhole.runAgentTaskWithSelection', 'inspect and improve the selected function');

  const chatRequest = requests.find(req => req.method === 'POST' && req.url === '/api/chat');
  assert.ok(chatRequest, 'agent chat endpoint was not called');
  assert.ok(
    String(chatRequest.body || '').includes('[VS Code Selection]'),
    'agent task did not include selected code context'
  );
}

function startMockBlackHoleApi(requests) {
  return new Promise((resolve, reject) => {
    let baseUrl = '';
    const transactions = [
      createTransaction('diff-1', 'reviewed'),
      createTransaction('diff-2', 'reviewed')
    ];
    const server = http.createServer(async (req, res) => {
      const body = await readBody(req);
      requests.push({ method: req.method, url: req.url, body, token: req.headers['x-blackhole-token'] || '' });

      if (req.method === 'GET' && req.url === '/api/bootstrap') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ baseUrl, token: 'test-token' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/workspace') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: JSON.parse(body || '{}').path || '' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/chat/resume-checkpoint') {
        writeSse(res, [
          { type: 'status', status: 'mock resume started' },
          { type: 'chunk', text: 'mock resume complete' },
          { type: 'end' }
        ]);
        return;
      }

      if (req.method === 'POST' && req.url === '/api/chat') {
        writeSse(res, [
          { type: 'status', status: 'mock agent started' },
          { type: 'tool_start', tool: 'inspect_code_context' },
          { type: 'tool_end', tool: 'inspect_code_context' },
          { type: 'chunk', text: 'mock agent complete' },
          { type: 'end' }
        ]);
        return;
      }

      if (req.method === 'POST' && req.url === '/api/terminal/run') {
        writeSse(res, [
          { type: 'output', log: 'mock terminal output' },
          { type: 'end', result: { ok: true } }
        ]);
        return;
      }

      if (req.method === 'POST' && req.url === '/api/ide/inline-edit') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          replacement: 'export function multiply(a, b) {\n  return a * b + 1;\n}\n'
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/ide/autocomplete') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, suggestion: 'return a - b;\n}' }));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/diff/transactions?limit=30') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transactions }));
        return;
      }

      const diffActionMatch = String(req.url || '').match(/^\/api\/diff\/transactions\/([^/]+)\/(accept|reject|rollback)$/);
      if (req.method === 'POST' && diffActionMatch) {
        const [, id, action] = diffActionMatch;
        const transaction = transactions.find(item => item.id === id);
        if (!transaction) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        transaction.status = action === 'rollback' ? 'rolled_back' : `${action}ed`;
        transaction.updatedAt = new Date().toISOString();
        if (action === 'accept') transaction.applyResult = transaction.review;
        if (action === 'rollback') transaction.rollbackResult = { ok: true, changedFiles: ['src/math.js'] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transaction }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    let attempts = 0;
    const listen = () => server.listen(randomInt(49152, 65536), '127.0.0.1');
    server.on('error', error => {
      if (++attempts < 20 && ['EADDRINUSE', 'EACCES'].includes(error.code)) listen();
      else reject(error);
    });
    server.once('listening', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, baseUrl });
    });
    listen();
  });
}

function createTransaction(id, status) {
  return {
    id,
    status,
    workspaceRoot: 'C:\\mock-workspace',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    review: {
      ok: true,
      changedFiles: ['src/math.js'],
      previews: [
        {
          ok: true,
          type: 'patch_file',
          path: 'src/math.js',
          diff: '--- src/math.js\n+++ src/math.js\n@@\n-return a * b;\n+return a * b + 1;\n'
        }
      ]
    }
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function writeSse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}
