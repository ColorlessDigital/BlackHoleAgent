function newlineFor(text, fallback = '') {
  return text.match(/\r?\n/)?.[0] || fallback;
}

function originalOffset(text, normalizedOffset) {
  let offset = 0;
  for (let normalized = 0; normalized < normalizedOffset; normalized++) {
    offset += text[offset] === '\r' && text[offset + 1] === '\n' ? 2 : 1;
  }
  return offset;
}

export function replaceTextBlock(current, search, replacement = '') {
  if (typeof search !== 'string') throw new Error('The search block must be a string.');
  let start = current.indexOf(search);
  let end = start + search.length;
  if (start < 0) {
    const normalizedSearch = search.replaceAll('\r\n', '\n');
    const index = current.replaceAll('\r\n', '\n').indexOf(normalizedSearch);
    if (index < 0) throw new Error('The search block does not exactly match the current file content (apart from LF/CRLF line endings).');
    start = originalOffset(current, index);
    end = originalOffset(current, index + normalizedSearch.length);
  }
  const newline = newlineFor(current.slice(start, end), newlineFor(current));
  const inserted = newline ? String(replacement ?? '').replace(/\r?\n/g, newline) : String(replacement ?? '');
  // Slice concatenation keeps replacement tokens such as $& literal and leaves unrelated bytes intact.
  return current.slice(0, start) + inserted + current.slice(end);
}

export function replaceTextLines(current, startLine, endLine, replacement = '') {
  const lines = current.split('\n');
  const start = Number(startLine) - 1;
  const end = Number(endLine) - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= lines.length) {
    throw new Error(`Invalid line range: ${startLine}-${endLine}`);
  }
  const newline = newlineFor(lines.slice(start, end + 1).join('\n'), newlineFor(current, '\n'));
  const inserted = String(replacement ?? '').replaceAll('\r\n', '\n').split('\n');
  if (newline === '\r\n') {
    for (let i = 0; i < inserted.length; i++) {
      if (i < inserted.length - 1 || end < lines.length - 1) inserted[i] += '\r';
    }
  }
  lines.splice(start, end - start + 1, ...inserted);
  return lines.join('\n');
}
