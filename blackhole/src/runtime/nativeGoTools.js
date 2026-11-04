function toolError(message) {
  const error = new Error(message);
  error.code = 'malformed_tool_call';
  return error;
}

export function normalizeGoToolDefinitions(tools) {
  return tools?.map(tool => ({ ...tool, parameters: {
    ...(tool.parameters || {}), type: 'object', properties: tool.parameters?.properties || {}
  } }));
}

export class NativeGoToolStream {
  constructor() { this.calls = new Map(); }

  collect(protocol, data, type) {
    if (protocol === 'chat') {
      for (const delta of data.choices?.[0]?.delta?.tool_calls || []) {
        const key = delta.index ?? delta.id;
        const call = this.calls.get(key) || { id: '', name: '', arguments: '' };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.name += delta.function.name;
        if (delta.function?.arguments) call.arguments += delta.function.arguments;
        this.calls.set(key, call);
      }
    } else if (protocol === 'messages') {
      if (type === 'content_block_start' && data.content_block?.type === 'tool_use') {
        const block = data.content_block;
        this.calls.set(data.index, { id: block.id, name: block.name, arguments: '', initial: block.input });
      }
      if (type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
        const call = this.calls.get(data.index);
        if (!call) throw toolError('Tool argument delta has no matching Messages tool block.');
        call.arguments += data.delta.partial_json || '';
      }
    } else if (protocol === 'responses') {
      if (type === 'response.output_item.added' && data.item?.type === 'function_call') {
        const item = data.item;
        this.calls.set(item.id, { id: item.call_id, name: item.name, arguments: item.arguments || '' });
      }
      if (type === 'response.function_call_arguments.delta') {
        const call = this.calls.get(data.item_id);
        if (!call) throw toolError('Tool argument delta has no matching Responses function item.');
        call.arguments += data.delta || '';
      }
      if (type === 'response.function_call_arguments.done') {
        const call = this.calls.get(data.item_id);
        if (call && data.arguments !== undefined) call.arguments = data.arguments;
      }
      if (type === 'response.output_item.done' && data.item?.type === 'function_call') {
        const item = data.item;
        const previous = this.calls.get(item.id);
        this.calls.set(item.id, { id: item.call_id || previous?.id, name: item.name || previous?.name, arguments: item.arguments ?? previous?.arguments ?? '' });
      }
    }
    for (const call of this.calls.values()) {
      if (call.arguments.length > 1024 * 1024) throw toolError('Streamed tool arguments exceed the parser budget.');
    }
    return this.calls.size > 0;
  }

  finish(tools = []) {
    const declared = new Set(tools.map(tool => tool.name));
    return [...this.calls.values()].map(call => {
      if (!call.id || !call.name || !declared.has(call.name)) throw toolError(`Invalid or undeclared tool call: ${call.name || 'missing name'}`);
      let params;
      try { params = call.arguments ? JSON.parse(call.arguments) : call.initial || {}; }
      catch { throw toolError(`Invalid JSON arguments for ${call.name}`); }
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw toolError(`Invalid argument object for ${call.name}`);
      return { id: call.id, name: call.name, params };
    });
  }
}

export function nativeGoHistory(messages, { protocol, model, sessionId }) {
  const history = [];
  let pending = [];
  const response = (call, content, failed = false) => {
    if (protocol === 'chat') history.push({ role: 'tool', tool_call_id: call.id, content });
    else if (protocol === 'responses') history.push({ type: 'function_call_output', call_id: call.id, output: content });
    else {
      const part = { type: 'tool_result', tool_use_id: call.id, content, ...(failed ? { is_error: true } : {}) };
      const previous = history.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every(p => p.type === 'tool_result')) previous.content.push(part);
      else history.push({ role: 'user', content: [part] });
    }
  };
  const closeMissing = () => {
    for (const call of pending) response(call, 'Tool result is unavailable in this retained context.', true);
    pending = [];
  };
  for (const message of messages) {
    if (protocol === 'messages' && message.role === 'system') continue;
    const state = message.goToolState;
    if (message.role === 'assistant' && state?.protocol === protocol && state.model === model && state.sessionId === sessionId) {
      closeMissing();
      pending = [...state.calls];
      if (protocol === 'chat') history.push({ role: 'assistant', content: state.text || null,
        tool_calls: state.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.params) } })) });
      else if (protocol === 'messages') history.push({ role: 'assistant', content: [
        ...(state.text ? [{ type: 'text', text: state.text }] : []),
        ...state.calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.params }))
      ] });
      else {
        if (state.text) history.push({ role: 'assistant', content: state.text });
        history.push(...state.calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.params) })));
      }
      continue;
    }
    const result = message.role === 'user' && String(message.content || '').match(/^\[Tool Result \(Tool: ([^)]+)\)\]/);
    const index = result ? pending.findIndex(call => call.name === result[1]) : -1;
    if (index >= 0) { const [call] = pending.splice(index, 1); response(call, message.content); }
    else { closeMissing(); history.push({ role: message.role, content: message.content }); }
  }
  closeMissing();
  return history;
}
