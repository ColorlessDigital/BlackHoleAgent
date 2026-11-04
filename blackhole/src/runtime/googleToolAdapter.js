export function googleContents(messages, model, sessionId) {
  const contents = [];
  let pending = [];
  const append = (role, parts) => {
    const previous = contents.at(-1);
    const responses = parts.some(part => part.functionResponse);
    const sameKind = previous && previous.parts.some(part => part.functionResponse) === responses;
    if (previous?.role === role && sameKind) previous.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };
  const closeUnexecuted = () => {
    if (!pending.length) return;
    append('user', pending.map(call => ({ functionResponse: { name: call.name,
      ...(call.id ? { id: call.id } : {}), response: { error: 'Tool result is unavailable in this retained context.' } } })));
    pending = [];
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    const state = message.goGoogleState;
    if (message.role === 'assistant' && state?.model === model && state.sessionId === sessionId && Array.isArray(state.parts)) {
      closeUnexecuted();
      // Go can append an unsigned empty text part after a streamed function call.
      // It carries no content and is rejected when replayed by some endpoints.
      const parts = state.parts.filter(part => !(part.text === '' && !part.thoughtSignature &&
        Object.keys(part).every(key => key === 'text' || key === 'thought')));
      append('model', parts);
      pending = state.parts.flatMap(part => part.functionCall ? [part.functionCall] : []);
      continue;
    }
    const result = message.role === 'user' && String(message.content || '').match(/^\[Tool Result \(Tool: ([^)]+)\)\]/);
    const index = result ? pending.findIndex(call => call.name === result[1]) : -1;
    if (index >= 0) {
      const [call] = pending.splice(index, 1);
      append('user', [{ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}),
        response: { result: message.content } } }]);
    } else {
      closeUnexecuted();
      if (String(message.content || '').trim()) append(message.role === 'assistant' ? 'model' : 'user', [{ text: message.content }]);
    }
  }
  closeUnexecuted();
  return contents;
}

export function googleFunctionCalls(parts, tools = []) {
  const names = new Set(tools.map(tool => tool.name));
  return parts.flatMap(part => {
    if (!part.functionCall) return [];
    const call = part.functionCall;
    if (!names.has(call.name)) throw new Error(`Undeclared Google function call: ${call.name}`);
    if (call.willContinue || call.partialArgs || (call.args !== undefined &&
      (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)))) throw new Error('Malformed Google function arguments');
    return [{ tool: call.name, params: call.args || {} }];
  });
}
