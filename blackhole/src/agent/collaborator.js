import { loadConfig } from '../config/configStore.js';
import { emitLog } from '../common/eventBus.js';
import { CapabilityExecutor } from '../capabilities/executor.js';
import { applySlidingContextGuard } from './contextGuard.js';
import { callLocalModel } from './llmRouter.js';
import { parseAllToolCalls } from './toolParser.js';
import { randomUUID } from 'node:crypto';

export async function runCollaborativeSession({ topic, agents, send, abortSignal = null, providerSessionId = randomUUID() }) {
  const config = loadConfig();
  const executor = new CapabilityExecutor({ getConfig: loadConfig });

  let sharedHistory = [
    {
      role: 'user',
      content: [
        'We need to complete the following project request:',
        `"${topic}"`,
        '',
        'Collaborate according to each assigned role. Design, implement, test, review, and summarize concrete progress.'
      ].join('\n')
    }
  ];

  const maxRounds = 2;

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (abortSignal?.aborted) break;
      for (const agent of agents) {
        if (abortSignal?.aborted) break;
        send({ type: 'agent_start', agent: agent.name });

        const systemPrompt = [
          `You are "${agent.name}", a member of the BlackHole collaborative coding group.`,
          `Role: ${agent.role}`,
          `Project request: "${topic}"`,
          `All participants: ${agents.map(a => `${a.name} (${a.role})`).join(', ')}`,
          '',
          '[Role Guide]',
          '- Analyst: clarify requirements, architecture, and implementation risks.',
          '- Implementer: write and modify source code.',
          '- Tester: validate behavior and suggest focused verification.',
          '- Reviewer: review structure, maintainability, and release readiness.',
          '',
          '[Instructions]',
          '1. Build on prior agent messages and contribute only from your own role.',
          '2. If real file or terminal work is needed, include one or more XML tool calls in your answer.',
          '3. Use professional, concise Korean or English depending on the user context.',
          '',
          'Available XML tools:',
          '- <list_dir path="relative/or/absolute" />',
          '- <read_file path="relative/or/absolute" />',
          '- <write_file path="relative/or/absolute">content</write_file>',
          '- <patch_file path="relative/or/absolute"><search>old</search><replace>new</replace></patch_file>',
          '- <patch_lines path="file" startLine="start" endLine="end">replacement</patch_lines>',
          '- <run_command command="command" />'
        ].join('\n');

        const guarded = applySlidingContextGuard(sharedHistory, systemPrompt, config.contextLimit);
        if (guarded.removed > 0) {
          emitLog(`Collaborative context trimmed ${guarded.removed} old message(s).`, 'warning');
        }

        if (abortSignal?.aborted) break;

        let assistantOutput = '';
        await callLocalModel(config, systemPrompt, guarded.messages, (chunk) => {
          if (abortSignal?.aborted) return;
          assistantOutput += chunk;
          send({ type: 'agent_chunk', agent: agent.name, text: chunk });
        }, { phase: 'general', task: topic, usageTag: 'collab', abortSignal, sessionId: providerSessionId });

        if (abortSignal?.aborted) break;

        sharedHistory.push({ role: 'user', content: `[${agent.name} (${agent.role}) opinion]:\n${assistantOutput}` });
        send({ type: 'agent_message', agent: agent.name, content: assistantOutput });

        const toolCalls = parseAllToolCalls(assistantOutput);
        for (const toolCall of toolCalls) {
          if (abortSignal?.aborted) break;
          send({ type: 'tool_start', tool: toolCall.tool, params: toolCall.params });
          emitLog(`[Collaborative Tool] ${agent.name} requested ${toolCall.tool}`, 'info');

          let result;
          const capability = toolCall.tool === 'list_dir' ? 'list_dir' : toolCall.tool;

          try {
            result = await executor.execute(capability, toolCall.params, {
              actor: 'ai',
              abortSignal,
              onOutput: (text) => send({ type: 'terminal_log', log: text })
            });
          } catch (err) {
            result = { ok: false, error: err.message };
          }

          send({ type: 'tool_end', result });
          sharedHistory.push({
            role: 'user',
            content: `[Tool result (${toolCall.tool})]:\n${JSON.stringify(result, null, 2)}`
          });
        }

        send({ type: 'agent_end', agent: agent.name });
        await new Promise(r => setTimeout(r, 800));
      }
    }
  } catch (error) {
    emitLog(`Collaborative session failed: ${error.message}`, 'error');
    send({ type: 'error', error: error.message });
  }

  send({ type: 'end' });
}
