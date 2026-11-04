import { useState } from 'react';
import type React from 'react';
import type { ApiClient, AppendTerminal, ChatMessage, ChatSession } from '../types.ts';

export default function useSessionState(
  client: ApiClient | null,
  appendTerminal: AppendTerminal | undefined,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
) {
  const [savedSessions, setSavedSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<number | string | null>(null);

  async function fetchSavedSessions(): Promise<void> {
    if (!client) return;
    try {
      const data = await client.request('/chats');
      setSavedSessions(data as ChatSession[]);
    } catch (error) {
      appendTerminal?.(`Failed to load chat sessions: ${(error as Error).message}`, 'error');
    }
  }

  function handleNewSession(): void {
    setMessages([{ role: 'assistant', content: '', i18nKey: 'welcomeMessage' }]);
    setCurrentSessionId(null);
    appendTerminal?.('New chat session started.', 'log');
  }

  function handleSelectSession(session: ChatSession): void {
    setMessages(session.messages || []);
    setCurrentSessionId(session.id);
    appendTerminal?.(`Chat session restored: ${session.title}`, 'success');
  }

  async function handleSaveSession(messages: ChatMessage[]): Promise<void> {
    if (!client) return;
    const sessionId = currentSessionId || Date.now();
    const firstUserMessage = messages.find(message => message.role === 'user');
    const defaultTitle = firstUserMessage
      ? (firstUserMessage.content.length > 20 ? `${firstUserMessage.content.substring(0, 20)}...` : firstUserMessage.content)
      : `Chat session - ${new Date(sessionId).toLocaleString()}`;

    const existing = currentSessionId ? savedSessions.find(session => session.id === currentSessionId) : null;
    const sessionTitle = existing?.title || defaultTitle;

    try {
      const data = await client.request('/chats/save', {
        method: 'POST',
        body: JSON.stringify({
          id: sessionId,
          title: sessionTitle,
          messages
        })
      });
      if (data.success) {
        setCurrentSessionId(sessionId);
        fetchSavedSessions();
        appendTerminal?.(`Chat session saved: ${data.session.title}`, 'success');
      } else {
        appendTerminal?.('Chat session save failed.', 'error');
      }
    } catch (error) {
      appendTerminal?.(`Chat session save failed: ${(error as Error).message}`, 'error');
    }
  }

  async function handleDeleteSession(event: React.MouseEvent, id: number | string): Promise<void> {
    if (!client) return;
    event.stopPropagation();
    if (!confirm('Delete this chat session?')) return;

    try {
      const data = await client.request(`/chats/${id}`, { method: 'DELETE' });
      if (data.success) {
        if (currentSessionId === id) handleNewSession();
        fetchSavedSessions();
        appendTerminal?.('Chat session deleted.', 'warning');
      } else {
        appendTerminal?.('Chat session delete failed.', 'error');
      }
    } catch (error) {
      appendTerminal?.(`Chat session delete failed: ${(error as Error).message}`, 'error');
    }
  }

  return {
    savedSessions, setSavedSessions,
    currentSessionId, setCurrentSessionId,
    fetchSavedSessions, handleNewSession, handleSelectSession, handleSaveSession, handleDeleteSession
  };
}
