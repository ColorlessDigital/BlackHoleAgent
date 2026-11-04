import { useRef, useState } from 'react';
import { consumeAgentEvents } from '../api/client.ts';
import type { ApiClient, AppendTerminal, CollabAgent, CollabMessage, StreamEvent } from '../types.ts';

const DEFAULT_AGENTS: CollabAgent[] = [
  { name: 'Analyst', role: 'Clarify requirements and architecture constraints' },
  { name: 'Developer', role: 'Design and implement the code change' },
  { name: 'Tester', role: 'Verify behavior, regressions, and edge cases' },
  { name: 'Reviewer', role: 'Review structure, maintainability, and release risk' }
];

function classifyLogType(text: unknown): string {
  const value = String(text || '');
  if (value.startsWith('PS ') || value.startsWith('PS>') || value.startsWith('>')) return 'command';
  if (/error|failed|syntaxerror|blocked|rejected/i.test(value)) return 'error';
  if (/warn|gate|pending/i.test(value)) return 'warning';
  if (/success|approved|completed/i.test(value)) return 'success';
  return 'log';
}

export default function useCollaborationState(
  client: ApiClient | null,
  appendTerminal: AppendTerminal | undefined,
  fetchFiles: (() => void) | undefined
) {
  const [collabTopic, setCollabTopic] = useState('');
  const [collabAgents, setCollabAgents] = useState<CollabAgent[]>(DEFAULT_AGENTS);
  const [collabMessages, setCollabMessages] = useState<CollabMessage[]>([]);
  const [isCollaborating, setIsCollaborating] = useState(false);
  const [activeCollabAgent, setActiveCollabAgent] = useState('');

  const collabAbortRef = useRef<AbortController | null>(null);

  async function handleStartCollaboration(): Promise<void> {
    if (!client) return;
    if (!collabTopic.trim()) {
      appendTerminal?.('Please enter a collaboration topic before starting.', 'warning');
      return;
    }

    setIsCollaborating(true);
    setCollabMessages([]);
    setActiveCollabAgent('');

    const controller = new AbortController();
    collabAbortRef.current = controller;

    appendTerminal?.(`[Collaboration Started] ${collabTopic}`, 'info');

    try {
      const response = await fetch(`${client.baseUrl}/api/agent/collaborate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-blackhole-token': client.token
        },
        body: JSON.stringify({
          topic: collabTopic,
          agents: collabAgents
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Collaboration failed (${response.status})`);
      }

      let failed = false;
      await consumeAgentEvents(response, event => {
        if (event.type === 'error') failed = true;
        if (event.type === 'end' && failed) return;
        processCollaborationEvent(event);
      });
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        appendTerminal?.(`[Collaboration Error] ${(error as Error).message}`, 'error');
        setCollabMessages(prev => [
          ...prev,
          { agent: 'System', content: `Error: ${(error as Error).message}`, type: 'error' }
        ]);
      }
    } finally {
      setIsCollaborating(false);
      setActiveCollabAgent('');
      collabAbortRef.current = null;
    }
  }

  function processCollaborationEvent(data: StreamEvent): void {
    if (data.type === 'agent_start') {
      setActiveCollabAgent(data.agent || '');
      setCollabMessages(prev => [
        ...prev,
        { agent: data.agent, content: '', status: 'thinking' }
      ]);
      return;
    }

    if (data.type === 'agent_chunk') {
      setCollabMessages(prev => {
        const next = [...prev];
        const index = next.map(message => message.agent).lastIndexOf(data.agent);
        if (index >= 0) {
          next[index] = {
            ...next[index],
            content: `${next[index].content || ''}${data.text || ''}`
          };
        }
        return next;
      });
      return;
    }

    if (data.type === 'agent_message') {
      setCollabMessages(prev => {
        const next = [...prev];
        const index = next.map(message => message.agent).lastIndexOf(data.agent);
        if (index >= 0) {
          next[index] = {
            ...next[index],
            content: data.content,
            status: 'done'
          };
        } else {
          next.push({ agent: data.agent, content: data.content, status: 'done' });
        }
        return next;
      });
      return;
    }

    if (data.type === 'tool_start') {
      appendTerminal?.(`[Collaboration Tool Start] ${data.tool}`, 'command');
      return;
    }

    if (data.type === 'tool_end') {
      appendTerminal?.('[Collaboration Tool End] Tool result received.', 'success');
      fetchFiles?.();
      return;
    }

    if (data.type === 'terminal_log') {
      appendTerminal?.(data.log ?? '', classifyLogType(data.log));
      return;
    }

    if (data.type === 'error') {
      setCollabMessages(prev => [
        ...prev,
        { agent: 'System', content: `Error: ${data.error}`, type: 'error' }
      ]);
      return;
    }

    if (data.type === 'end') {
      appendTerminal?.('[Collaboration Completed] All agents finished.', 'success');
    }
  }

  function handleStopCollaboration(): void {
    if (collabAbortRef.current) {
      collabAbortRef.current.abort();
      collabAbortRef.current = null;
    }
    setIsCollaborating(false);
    setActiveCollabAgent('');
    appendTerminal?.('[Collaboration Stopped] Stopped by user.', 'warning');
  }

  return {
    collabTopic, setCollabTopic,
    collabAgents, setCollabAgents,
    collabMessages, setCollabMessages,
    isCollaborating, setIsCollaborating,
    activeCollabAgent, setActiveCollabAgent,
    handleStartCollaboration, handleStopCollaboration,
    collabAbortRef
  };
}
