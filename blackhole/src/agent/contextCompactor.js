import { estimateConversationTokens, estimateTextTokens, boundToolMessages, userGoalIndices } from './contextGuard.js';

// Summarization-based context compaction.
//
// Unlike the sliding guard (which deletes), compaction replaces the middle of
// a long conversation with a single LLM-written summary so long agent runs
// keep working past the context limit. Anchors: first message (user goal) and
// the most recent tail turns are always preserved verbatim.

export const COMPACTION_SYSTEM_PROMPT = [
  'You are a context compaction summarizer for an autonomous coding agent.',
  'Summarize the conversation transcript below into a compact brief the agent can continue from.',
  'Include: user goal, key decisions, files read/changed with paths, tool results that still matter,',
  'verification outcomes, errors encountered, and the next planned step.',
  'Write in the same language as the transcript. Keep it under 1500 characters. No preamble.'
].join('\n');

export function needsCompaction(messages = [], systemPrompt = '', limitTokens = 8192, threshold = 0.9) {
  const limit = Number(limitTokens) || 8192;
  const ratio = Number.isFinite(Number(threshold)) ? Math.max(0, Number(threshold)) : 0.9;
  const estimated = estimateConversationTokens(messages, systemPrompt);
  return { needed: estimated > Math.floor(limit * ratio), estimatedTokens: estimated, limitTokens: limit };
}

// Split: head (first message = goal anchor) + middle (summarize) + tail.
export function selectCompactionWindow(messages = [], tailTurns = 4, userGoal) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length < 1 + tailTurns + 3) return null; // need head + >=3 middle + tail
  const goals = userGoalIndices(list, userGoal);
  const headIndex = goals[0] ?? 0;
  const currentGoal = userGoal ? list.findLastIndex(message => message.role === 'user' && message.content === userGoal) : -1;
  const tailStart = currentGoal > headIndex ? Math.min(currentGoal, list.length - tailTurns) : list.length - tailTurns;
  const tailIndices = new Set([...Array.from({ length: list.length - tailStart }, (_, i) => tailStart + i), ...goals.slice(1)]);
  const middle = list.filter((_, i) => i !== headIndex && !tailIndices.has(i));
  if (middle.length < 3) return null;
  return { head: [list[headIndex]], middle,
    tail: list.filter((_, i) => i !== headIndex && tailIndices.has(i)) };
}

export function compactionTranscriptBudget(contextLimit) {
  return Math.max(0, Math.floor(Number(contextLimit || 8192) * 0.85) - estimateTextTokens(COMPACTION_SYSTEM_PROMPT) - 64);
}

function excerpt(text, maxChars) {
  if (text.length <= maxChars) return text;
  const marker = '\n[...]\n';
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  const head = Math.ceil((maxChars - marker.length) * 0.65);
  const tail = maxChars - marker.length - head;
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : '');
}

export function buildCompactionTranscript(middle = [], { maxTokens } = {}) {
  const render = maxChars => middle
    .map((msg, index) => {
      const role = msg?.role || 'unknown';
      const content = excerpt(String(msg?.content || ''), maxChars);
      return `[${index + 1}][${role}]\n${content}`;
    })
    .join('\n\n');
  let output = render(4000);
  if (!Number.isFinite(maxTokens) || estimateTextTokens(output) <= maxTokens) return output;
  if (maxTokens <= 0) return '';
  // Share the input budget across turns instead of dropping entire middle turns.
  let low = 0, high = 4000;
  while (low < high) {
    const middleChars = Math.ceil((low + high) / 2);
    if (estimateTextTokens(render(middleChars)) <= maxTokens) low = middleChars;
    else high = middleChars - 1;
  }
  output = render(low);
  if (estimateTextTokens(output) <= maxTokens) return output;
  low = 0; high = output.length;
  while (low < high) {
    const chars = Math.ceil((low + high) / 2);
    if (estimateTextTokens(excerpt(output, chars)) <= maxTokens) low = chars;
    else high = chars - 1;
  }
  return excerpt(output, low);
}

// summarize: async (transcript) => summary string. Injectable for tests.
export async function compactConversation({ messages = [], systemPrompt = '', limitTokens = 8192, threshold = 0.9, tailTurns = 4, summarize, abortSignal, userGoal, transcriptLimitTokens }) {
  abortSignal?.throwIfAborted();
  messages = boundToolMessages(messages).messages;
  const check = needsCompaction(messages, systemPrompt, limitTokens, threshold);
  if (!check.needed) {
    return { messages, compacted: false, removed: 0, estimatedTokens: check.estimatedTokens };
  }
  const window = selectCompactionWindow(messages, tailTurns, userGoal);
  if (!window) {
    return { messages, compacted: false, removed: 0, estimatedTokens: check.estimatedTokens, reason: 'too-short-to-compact' };
  }
  if (typeof summarize !== 'function') {
    return { messages, compacted: false, removed: 0, estimatedTokens: check.estimatedTokens, reason: 'no-summarizer' };
  }
  const transcript = buildCompactionTranscript(window.middle, { maxTokens: transcriptLimitTokens });
  let summary = '';
  try {
    summary = String(await summarize(transcript) || '').trim();
    abortSignal?.throwIfAborted();
  } catch (err) {
    if (abortSignal?.aborted || err.name === 'AbortError') throw err;
    return { messages, compacted: false, removed: 0, estimatedTokens: check.estimatedTokens, reason: `summarizer-failed: ${err.message}` };
  }
  if (!summary) {
    return { messages, compacted: false, removed: 0, estimatedTokens: check.estimatedTokens, reason: 'empty-summary' };
  }
  const compactedMessages = [
    ...window.head,
    {
      role: 'user',
      content: `[Compacted context summary — ${window.middle.length} earlier turns summarized to preserve the context window]\n${summary.slice(0, 6000)}`
    },
    ...window.tail
  ];
  return {
    messages: compactedMessages,
    compacted: true,
    removed: window.middle.length - 1,
    estimatedTokens: estimateConversationTokens(compactedMessages, systemPrompt),
    previousTokens: check.estimatedTokens
  };
}
