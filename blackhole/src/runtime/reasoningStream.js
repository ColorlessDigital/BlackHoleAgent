const OPENINGS = ['<think>', '<thinking>', '<analysis>'];

// Only a leading model wrapper is a reasoning channel; tags inside answers,
// code fences, and tool arguments remain literal content.
export function createReasoningStream({ onContent, onReasoning }) {
  let mode = 'prefix';
  let buffer = '';
  let closing = '';
  let finished = false;

  function drain() {
    while (buffer) {
      if (mode === 'answer') {
        onContent?.(buffer);
        buffer = '';
        return;
      }
      if (mode === 'prefix') {
        const whitespace = buffer.match(/^\s+/)?.[0] || '';
        if (whitespace) {
          onContent?.(whitespace);
          buffer = buffer.slice(whitespace.length);
          if (!buffer) return;
        }
        const lower = buffer.toLowerCase();
        const opening = OPENINGS.find(tag => lower.startsWith(tag));
        if (opening) {
          buffer = buffer.slice(opening.length);
          closing = `</${opening.slice(1)}`;
          mode = 'reasoning';
          continue;
        }
        if (OPENINGS.some(tag => tag.startsWith(lower))) return;
        mode = 'answer';
        continue;
      }
      const lower = buffer.toLowerCase();
      const end = lower.indexOf(closing);
      if (end >= 0) {
        if (end) onReasoning?.(buffer.slice(0, end));
        buffer = buffer.slice(end + closing.length);
        mode = 'prefix';
        continue;
      }
      let keep = Math.min(buffer.length, closing.length - 1);
      while (keep && !closing.startsWith(lower.slice(-keep))) keep--;
      const ready = buffer.length - keep;
      if (ready) onReasoning?.(buffer.slice(0, ready));
      buffer = buffer.slice(ready);
      return;
    }
  }

  return {
    write(text) {
      if (finished || typeof text !== 'string' || !text) return;
      buffer += text;
      drain();
    },
    finish() {
      if (finished) return;
      finished = true;
      if (buffer) (mode === 'reasoning' ? onReasoning : onContent)?.(buffer);
      buffer = '';
    }
  };
}
