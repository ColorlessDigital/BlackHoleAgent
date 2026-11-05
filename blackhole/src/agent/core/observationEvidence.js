import path from 'node:path';
import { isObservationGoal } from './taskGraphPlanner.js';

const MAX_QUOTE_CHARS = 4096;
const literalPath = '(?:`([^`]+)`|"([^"]+)"|\'([^\']+)\'|([^\\s,;]+))';

export function resolveFileQuoteRequest(goal = '') {
  const text = String(goal).trim();
  if (/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:explain|describe|tell\s+me|review|evaluate|analy[sz]e|how\b|what\b|why\b)/i.test(text)) return null;
  const read = new RegExp(`\\bread\\s+(?:(?:the|newly\\s+created)\\s+)*${literalPath}\\s+and\\s+(?:then\\s+)?quote\\b`, 'i').exec(text);
  const korean = /(?:그대로|정확히|인용)/.test(text) && /(?:읽고|읽어|읽은)/.test(text)
    ? new RegExp(`${literalPath}\\s*(?:파일(?:을|의)?|(?:을|를))`).exec(text) : null;
  const match = read || korean;
  if (!match) return null;
  const target = match.slice(1, 5).find(value => value !== undefined)?.trim();
  const quoted = match.slice(1, 4).some(value => value !== undefined);
  if (!target || /[<>*?|{}$]/.test(target) || /^[a-z][a-z\d+.-]+:/i.test(target) ||
      /[\\/]$/.test(target) || /^(?:\.|\.\.|this|that|it|them|file|document)$/i.test(target)) return null;
  if (!quoted && !/[\\/.]/.test(target) && !/^[a-z]:/i.test(target) && !/^[A-Z0-9_-]+$/.test(target)) return null;
  const partial = /\b(?:first|last|line|lines|word|words|character|characters|part|paragraph|section|sentence|snippet|substring|excerpt)\b|첫|마지막|부분|구간|단어|문장|글자|문자|문단|줄/.test(text.toLowerCase());
  const quotation = read ? text.slice(read.index + read[0].length) : '';
  const exactQuote = !partial && (/^\s+(?:(?:its|the)\s+)?(?:(?:current|latest|entire|whole|full)\s+)*(?:value|contents?|text)\s+(?:exactly|verbatim|as[- ]is)\b/i.test(quotation)
    || /^\s+(?:(?:its|the)\s+)?(?:entire|whole|full)\s+(?:contents?|text)\b/i.test(quotation));
  return { path: target, exactQuote };
}

function canonical(file, workspaceRoot) {
  const absolute = path.resolve(workspaceRoot, file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

// Only verifies explicit literal-file quotation requests, using tool results from
// this run. No background file access, inferred values, or checkpoint replay.
export class ObservationEvidence {
  constructor(goal, workspaceRoot) {
    const request = isObservationGoal(goal) ? resolveFileQuoteRequest(goal) : null;
    this.request = request?.exactQuote ? request : null;
    this.workspaceRoot = workspaceRoot;
    this.observation = null;
  }

  observe(toolCall, result) {
    if (!this.request || toolCall.tool !== 'read_file' || result?.ok !== true) return null;
    const data = result.result;
    if (!data || typeof data.content !== 'string' || !toolCall.params?.path) return null;
    const key = canonical(this.request.path, this.workspaceRoot);
    if (canonical(toolCall.params.path, this.workspaceRoot) !== key) return null;
    if (this.request.exactQuote && ((data.startLine ?? 1) !== 1 || data.hasMore === true)) return null;
    this.observation = { path: this.request.path,
      quote: this.request.exactQuote && data.content.length <= MAX_QUOTE_CHARS ? data.content.trim() : null };
    return this.observation.quote === null ? null : key;
  }

  verify(answer) {
    if (!this.request) return { ok: true, applicable: false };
    if (!this.observation) return { ok: false, reason: 'requested_file_not_read', path: this.request.path };
    const quote = this.observation.quote;
    if (quote === null) return { ok: true, scope: 'fresh_read_only', path: this.request.path };
    const normalize = text => String(text).replaceAll('\r\n', '\n');
    if (quote && !normalize(answer).includes(normalize(quote))) {
      return { ok: false, reason: 'requested_quote_missing', path: this.request.path };
    }
    return { ok: true, scope: 'fresh_read_and_quote', path: this.request.path };
  }

  recoveryMessage(result) {
    return ['[Requested File Evidence]',
      `Completion check: ${result.reason}. Requested file: ${JSON.stringify(this.request.path)}.`,
      this.observation?.quote !== null && this.observation
        ? `Actual read_file content from this run: ${JSON.stringify(this.observation.quote)}. Include the requested quotation in the final answer.`
        : 'Read the requested file through read_file before claiming the current value. Earlier conversation values are not a fresh read.',
      'Continue the current observation request; this check does not request a file edit.'
    ].join('\n');
  }
}
