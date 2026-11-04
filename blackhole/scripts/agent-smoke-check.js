import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentStateMachine } from '../src/agent/core/stateMachine.js';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-agent-smoke-'));
const toXmlPath = (value) => String(value).replace(/\\/g, '/');
const nodeCommand = `${toXmlPath(process.execPath)} --test smoke.test.js`;
const events = [];

function send(event) {
  events.push(event);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const packageJsonPath = toXmlPath(path.join(workspaceRoot, 'package.json'));
const smokeSourcePath = toXmlPath(path.join(workspaceRoot, 'smoke.js'));
const smokeTestPath = toXmlPath(path.join(workspaceRoot, 'smoke.test.js'));
const smokeOutputPath = toXmlPath(path.join(workspaceRoot, 'smoke-output.txt'));
const workspaceXmlPath = toXmlPath(workspaceRoot);

const stateMachine = new AgentStateMachine({
  send,
  messages: [{ role: 'user', content: 'Run the autonomous smoke check.' }],
  config: {
    workspaceRoot,
    permissionMode: 'autonomous',
    activeModel: 'llamacpp:local-gguf',
    localRuntime: 'llamacpp',
    systemInstruction: 'Autonomous smoke check. Use tools directly and avoid repeated text.',
    selfHealingMaxCycles: 1,
    agentCheckpointRetentionLimit: 2
  }
});

stateMachine.checkpointStore = {
  save(checkpoint) {
    return {
      sessionId: checkpoint.sessionId,
      savedAt: new Date().toISOString(),
      path: path.join(workspaceRoot, `${checkpoint.sessionId}.json`),
      latestPath: path.join(workspaceRoot, 'latest.json')
    };
  }
};

stateMachine.callModel = async (_systemPrompt, _conversation, onChunk) => {
  onChunk([
    'Plan: create a minimal test project and run it.',
    `<write_file path="${packageJsonPath}">{"type":"module","scripts":{"test":"node --test smoke.test.js"}}</write_file>`,
    `<write_file path="${smokeSourcePath}">export function answer() { return 42; }`,
    '</write_file>',
    `<write_file path="${smokeTestPath}">import test from 'node:test';`,
    "import assert from 'node:assert';",
    "import { answer } from './smoke.js';",
    "test('answer', () => assert.strictEqual(answer(), 42));",
    '</write_file>',
    `<run_command command="${nodeCommand}" cwd="${workspaceXmlPath}" />`,
    `<write_file path="${smokeOutputPath}">smoke-ok</write_file>`
  ].join('\n'));
};

try {
  await stateMachine.run();

  const toolEndEvents = events.filter(event => event.type === 'tool_end');
  const blockedEvents = toolEndEvents.filter(event => event.result?.blocked || event.result?.rejected);
  const failedTools = toolEndEvents.filter(event => event.result?.ok === false);
  const runCommandEvent = toolEndEvents.find(event => event.tool === 'run_command');
  const verifyEvent = events.find(event => event.type === 'state_change' && event.state === 'VERIFY' && event.payload?.results);
  const visibleAnswer = events
    .filter(event => event.type === 'chunk')
    .map(event => event.text)
    .join('');

  assert(toolEndEvents.length >= 4, `Expected at least 4 tool executions, got ${toolEndEvents.length}.`);
  assert(blockedEvents.length === 0, `Autonomous smoke check had blocked/rejected tool calls: ${JSON.stringify(blockedEvents)}`);
  assert(failedTools.length === 0, `Autonomous smoke check had failed tools: ${JSON.stringify(failedTools)}`);
  assert(runCommandEvent?.result?.result?.code === 0, `run_command did not exit cleanly: ${JSON.stringify(runCommandEvent?.result)}`);
  assert(fs.existsSync(path.join(workspaceRoot, 'smoke-output.txt')), 'Expected smoke-output.txt to be created.');
  assert(verifyEvent?.payload?.results?.test?.ok === true, 'Verification test result was not successful.');
  assert(!visibleAnswer.includes('<write_file') && !visibleAnswer.includes('<run_command'), 'Visible answer leaked internal XML tool calls.');
  const visibleLines = visibleAnswer
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const hasConsecutiveDuplicateLine = visibleLines.some((line, index) => index > 0 && line === visibleLines[index - 1]);
  assert(!hasConsecutiveDuplicateLine, 'Visible answer contains consecutive duplicate lines.');

  console.log('BlackHole autonomous agent smoke check passed.');
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Tools executed: ${toolEndEvents.map(event => event.tool).join(', ')}`);
  console.log(`Visible answer: ${visibleAnswer.replace(/\s+/g, ' ').trim()}`);
} finally {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}
