import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import { runAgentSession } from './orchestrator.js';
import { LlamaCppRuntime } from '../runtime/llamaCppRuntime.js';
import { CapabilityExecutor } from '../capabilities/executor.js';
import { AgentCheckpointStore } from './core/checkpointStore.js';

describe('orchestrator - runAgentSession', () => {
  test('should execute ReAct loop with tool calls and accumulate feedback', async () => {
    let callCount = 0;
    const sentEvents = [];

    // Mock chatStream of LlamaCppRuntime
    const mockChatStream = mock.method(
      LlamaCppRuntime.prototype,
      'chatStream',
      async (options, onChunk) => {
        callCount++;
        if (callCount === 1) {
          // First turn: model outputs a tool call to read index.js
          const response = 'I need to read index.js to understand the codebase.\n<read_file path="src/index.js" />';
          for (const char of response) {
            onChunk(char);
          }
        } else {
          // Second turn: model summarizes and finishes
          const response = 'Based on the file content, the codebase looks healthy and complete.';
          for (const char of response) {
            onChunk(char);
          }
        }
      }
    );

    // Mock execute of CapabilityExecutor
    const mockExecute = mock.method(
      CapabilityExecutor.prototype,
      'execute',
      async (capability, params, options) => {
        assert.strictEqual(capability, 'read_file');
        assert.strictEqual(params.path, 'src/index.js');
        return { ok: true, content: 'console.log("Hello BlackHole");' };
      }
    );
    const mockCheckpointSave = mock.method(
      AgentCheckpointStore.prototype,
      'save',
      (checkpoint) => ({
        sessionId: checkpoint.sessionId,
        savedAt: new Date().toISOString(),
        path: 'mock-checkpoint.json',
        latestPath: 'mock-latest.json'
      })
    );

    const send = (evt) => {
      sentEvents.push(evt);
    };

    const messages = [{ role: 'user', content: '체크해줘' }];
    await runAgentSession({ messages, send });

    // Verify events sequence
    const statusEvents = sentEvents.filter(e => e.type === 'status');
    const chunkEvents = sentEvents.filter(e => e.type === 'chunk');
    const toolStartEvents = sentEvents.filter(e => e.type === 'tool_start');
    const toolEndEvents = sentEvents.filter(e => e.type === 'tool_end');
    const endEvents = sentEvents.filter(e => e.type === 'end');

    assert.ok(statusEvents.length >= 2);
    assert.strictEqual(toolStartEvents.length, 1);
    assert.strictEqual(toolStartEvents[0].tool, 'read_file');
    assert.strictEqual(toolEndEvents.length, 1);
    assert.strictEqual(toolEndEvents[0].result.ok, true);
    assert.strictEqual(endEvents.length, 1);

    // Clean up mocks
    mockChatStream.mock.restore();
    mockExecute.mock.restore();
    mockCheckpointSave.mock.restore();
  });
});
