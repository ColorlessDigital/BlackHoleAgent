/**
 * Smart Context Compactor & Guard
 * Protects initial user goals and recent instructions while hierarchically
 * compacting long tool results and sliding middle turns when approaching context limits.
 */

export function estimateTextTokens(text = '') {
  if (!text) return 0;
  const str = String(text);
  let cjkCount = 0;
  let otherCount = 0;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // CJK Unified Ideographs, Hangul Syllables, Hiragana/Katakana
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }

  // CJK characters average ~1.5 chars per token in typical BPE models
  // Latin / Code average ~3.5 chars per token
  return Math.ceil(cjkCount / 1.5 + otherCount / 3.5);
}

export function estimateConversationTokens(messages = [], systemPrompt = '') {
  let total = estimateTextTokens(systemPrompt);
  for (const msg of messages) {
    total += estimateTextTokens(msg?.content || '');
  }
  return total;
}

export function compactToolResultContent(content, maxChars = 600) {
  const text = String(content || '');
  if (text.length <= maxChars) return text;

  const toolMatch = text.match(/^\[Tool Result \(Tool: ([^)]+)\)\]/);
  const prefix = toolMatch ? toolMatch[0] : '[Tool Result]';
  const remaining = text.slice(prefix.length).trim();

  const budget = Math.max(0, maxChars - prefix.length - 100);
  const headChars = Math.ceil(budget * 0.65);
  const tailChars = budget - headChars;
  const head = remaining.slice(0, headChars);
  const tail = tailChars ? remaining.slice(-tailChars) : '';
  const trimmed = remaining.length - budget;

  return `${prefix}\n${head}\n\n... [Trimmed ${trimmed} chars to preserve context window] ...\n\n${tail}`;
}

export function isToolResultMessage(message) {
  return message?.role === 'tool' || (message?.role === 'user' && /^\[Tool Result\b/.test(String(message.content || '')));
}

export function boundToolMessages(messages = [], maxChars = 6000) {
  let compacted = 0;
  const output = messages.filter(msg => msg && (String(msg.content || '').trim() || msg.goGoogleParts))
    .map(msg => {
      if (isToolResultMessage(msg) && String(msg.content || '').length > maxChars) {
        compacted++;
        return { ...msg, content: compactToolResultContent(msg.content, maxChars) };
      }
      return { ...msg };
    });
  return { messages: output, compacted };
}

export function userGoalIndices(messages, userGoal) {
  const indices = messages.flatMap((msg, i) => msg.role === 'user' && !isToolResultMessage(msg) &&
    !/^\[(?:Compacted context summary|Loop Guard|Tool Batch Guard|System Directive|Checkpoint Resume Context)/.test(String(msg.content || '')) ? [i] : []);
  const explicit = userGoal ? messages.findLastIndex(msg => msg.role === 'user' && msg.content === userGoal) : -1;
  return [...new Set([indices[0], explicit >= 0 ? explicit : indices.at(-1)].filter(i => i !== undefined))];
}

export function applySlidingContextGuard(messages = [], systemPrompt = '', limitTokens = 8192, { userGoal } = {}) {
  const targetTokenLimit = Math.floor(Number(limitTokens || 8192) * 0.85); // 15% safety headroom
  const bounded = boundToolMessages(Array.isArray(messages) ? messages : []);
  const output = bounded.messages;
  let compacted = bounded.compacted;
  let removed = 0;

  const currentTokens = () => estimateConversationTokens(output, systemPrompt);

  // Even the newest tool result must fit; user instructions are never clipped.
  for (let i = 0; i < output.length && currentTokens() > targetTokenLimit; i++) {
    const msg = output[i];
    if (isToolResultMessage(msg)) {
      const originalLength = msg.content.length;
      if (originalLength > 600) {
        msg.content = compactToolResultContent(msg.content, 600);
        compacted++;
        if (currentTokens() <= targetTokenLimit) {
          break;
        }
      }
    }
  }

  const protectedMessages = new Set(userGoalIndices(output, userGoal).map(i => output[i]));
  while (currentTokens() > targetTokenLimit) {
    const index = output.findIndex((msg, i) => !protectedMessages.has(msg) && i < output.length - 2);
    const removable = index >= 0 ? index : output.findIndex(msg => !protectedMessages.has(msg));
    if (removable < 0) break;
    output.splice(removable, 1);
    removed++;
  }

  return {
    messages: output,
    removed,
    compacted,
    estimatedTokens: currentTokens(),
    limitExceeded: currentTokens() > targetTokenLimit
  };
}
