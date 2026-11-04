// Build previews without first serializing an unbounded tool result.
export function previewData(value, { maxChars = 8000, maxItems = 40, maxDepth = 6 } = {}) {
  let remaining = Math.max(0, maxChars);
  const seen = new WeakSet();
  function visit(item, depth) {
    if (remaining <= 0) return '[Preview budget reached]';
    if (typeof item === 'string') {
      const length = Math.min(item.length, remaining);
      remaining -= length;
      return length === item.length ? item : `${item.slice(0, length)} [${item.length - length} characters omitted]`;
    }
    if (!item || typeof item !== 'object') { remaining -= 16; return item; }
    if (seen.has(item)) return '[Circular]';
    if (depth >= maxDepth) return Array.isArray(item) ? `[Array: ${item.length} items]` : '[Nested object]';
    seen.add(item);
    const entries = Array.isArray(item) ? item.entries() : Object.entries(item);
    const output = Array.isArray(item) ? [] : {};
    let count = 0;
    for (const [key, child] of entries) {
      if (count >= maxItems || remaining <= 0) break;
      remaining -= String(key).length + 8;
      const result = visit(child, depth + 1);
      if (Array.isArray(output)) output.push(result);
      else Object.defineProperty(output, key, { value: result, enumerable: true, configurable: true });
      count++;
    }
    const total = Array.isArray(item) ? item.length : Object.keys(item).length;
    if (count < total) {
      if (Array.isArray(output)) output.push({ omittedItems: total - count });
      else output.$omittedFields = total - count;
    }
    seen.delete(item);
    return output;
  }
  return visit(value, 0);
}
