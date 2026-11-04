import type { ChatMessage, ReasoningRecord, StreamEvent } from '../types.ts';

export function appendReasoning(messages: ChatMessage[], assistantIndex: number, event: StreamEvent): ChatMessage[] {
  const message = messages[assistantIndex];
  if (message?.role !== 'assistant' || typeof event.text !== 'string' || !event.text) return messages;
  const id = typeof event.requestId === 'string' ? event.requestId : `reasoning-${assistantIndex}`;
  const timestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
  const records = [...(message.reasoning || [])];
  const index = records.findIndex(record => record.id === id);
  if (index >= 0) records[index] = { ...records[index], text: records[index].text + event.text, updatedAt: timestamp };
  else {
    const record: ReasoningRecord = { id, text: event.text, startedAt: timestamp, updatedAt: timestamp };
    if (typeof event.model === 'string') record.model = event.model;
    if (typeof event.phase === 'string') record.phase = event.phase;
    if (Number.isSafeInteger(event.step)) record.step = event.step;
    records.push(record);
  }
  return messages.map((current, index) => index === assistantIndex ? { ...current, reasoning: records } : current);
}

export function messagesWithoutReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => !(message.role === 'assistant' && !message.content && message.reasoning?.length))
    .map(message => {
      const next = { ...message };
      delete next.reasoning;
      return next;
    });
}
