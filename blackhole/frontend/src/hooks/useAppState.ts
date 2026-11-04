import { useEffect, useRef, useState } from 'react';
import { bootstrapApi, createApiClient } from '../api/client.ts';
import type { ApiBootstrap, ApiClient, AppConfig } from '../types.ts';

import useChatState from './useChatState.ts';
import useCollaborationState from './useCollaborationState.ts';
import useIdeState from './useIdeState.ts';
import useLayoutState from './useLayoutState.ts';
import useRuntimeState from './useRuntimeState.ts';
import useSessionState from './useSessionState.ts';
import useWorkspaceState from './useWorkspaceState.ts';

export default function useAppState() {
  const [client, setClient] = useState<ApiClient | null>(null);
  const [apiConfig, setApiConfig] = useState<ApiBootstrap | null>(null);
  const fetchFilesRef = useRef<() => void>(() => {});

  const chatState = useChatState(client, () => fetchFilesRef.current());
  const { appendTerminal, setMessages, setTerminalLines } = chatState;

  const layoutState = useLayoutState(appendTerminal);
  const { setActiveTab } = layoutState;

  const workspaceState = useWorkspaceState(client, appendTerminal, setActiveTab);
  const { fetchFiles, fetchWorkspacePath } = workspaceState;

  const sessionState = useSessionState(client, appendTerminal, setMessages);
  const { fetchSavedSessions } = sessionState;

  const runtimeState = useRuntimeState(client, appendTerminal);
  const { fetchLlamaRuntimeStatus, fetchRuntimeDiscover } = runtimeState;

  const ideState = useIdeState(client, appendTerminal);
  const collaborationState = useCollaborationState(client, appendTerminal, fetchFiles);

  useEffect(() => {
    fetchFilesRef.current = fetchFiles;
  }, [fetchFiles]);

  useEffect(() => {
    async function init() {
      try {
        const boot = await bootstrapApi();
        setApiConfig(boot);
        setClient(createApiClient(boot));
      } catch (error) {
        console.error('API bootstrap failed:', error);
        appendTerminal(`API bootstrap failed: ${(error as Error).message}`, 'error');
      }
    }
    init();
  }, [appendTerminal]);

  useEffect(() => {
    if (!client) return;

    runtimeState.fetchConfig();
    fetchFiles();
    fetchSavedSessions();
    chatState.fetchAgentCheckpoints();
    fetchWorkspacePath();
    fetchLlamaRuntimeStatus();
    fetchRuntimeDiscover();
    runtimeState.fetchModelCatalog();
    runtimeState.fetchUsage();

  }, [client]);

  useEffect(() => {
    if (!client) return;

    const eventSource = new EventSource(client.eventsUrl);
    let approvalRevision = 0;
    let disposed = false;
    const syncApprovals = async () => {
      const revision = approvalRevision;
      try {
        const response = await client.request('/security/pending');
        if (disposed || revision !== approvalRevision) return;
        const pending = response.pending?.[0];
        chatState.setPendingSecurityAction(pending ? {
          id: pending.id,
          tool: pending.action?.capability || 'run_command',
          params: pending.action?.params || {},
          reason: pending.policy?.reason || 'Tool approval required'
        } : null);
      } catch { /* Keep the last pending action during a transient disconnect. */ }
    };
    eventSource.addEventListener('open', () => { void syncApprovals(); });

    eventSource.addEventListener('log', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        const isCommand = data.level === 'command';
        setTerminalLines(prev => [
          ...prev,
          {
            text: data.message,
            type: isCommand ? 'command' : (data.level === 'info' ? 'log' : data.level)
          }
        ]);
      } catch (error) {
        console.error('SSE log parse error:', error);
      }
    });

    eventSource.addEventListener('approval', (event) => {
      try {
        approvalRevision++;
        const data = JSON.parse((event as MessageEvent).data);
        chatState.setPendingSecurityAction({
          id: data.id,
          tool: data.action?.capability || 'run_command',
          params: data.action?.params || {},
          reason: data.policy?.reason || 'Tool approval required'
        });
      } catch (error) {
        console.error('SSE approval parse error:', error);
      }
    });

    eventSource.addEventListener('approval_resolved', (event) => {
      try {
        approvalRevision++;
        const data = JSON.parse((event as MessageEvent).data);
        chatState.setPendingSecurityAction(previous => previous?.id === data.id ? null : previous);
        void syncApprovals();
      } catch (error) {
        console.error('SSE approval resolution parse error:', error);
      }
    });

    eventSource.onerror = (error) => {
      console.warn('SSE stream reconnecting...', error);
    };

    return () => { disposed = true; eventSource.close(); };
  }, [client]);

  const customHandleSelectGgufFile = () => {
    runtimeState.handleSelectGgufFile();
  };

  async function handleResumeWithOutputLimit(model: string, maxTokens: number) {
    if (!client || chatState.isThinking) throw new Error('Agent is busy or disconnected.');
    const saved = await client.request<AppConfig>('/models/opencode-go/output-limit', {
      method: 'POST', body: JSON.stringify({ model, maxTokens })
    });
    runtimeState.setConfig(saved);
    await chatState.handleResumeLatestCheckpoint();
  }

  return {
    client,
    apiConfig,
    ...layoutState,
    ...workspaceState,
    ...sessionState,
    ...runtimeState,
    ...ideState,
    ...collaborationState,
    ...chatState,
    handleResumeWithOutputLimit,
    handleSelectGgufFile: customHandleSelectGgufFile
  };
}
