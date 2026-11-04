import { StringDecoder } from 'node:string_decoder';

export class McpDiagnosticTail {
  constructor(environment = {}, maxChars = 4000) {
    const values = Object.entries(environment)
      .filter(([key, value]) => /TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL|CONNECTION_STRING/i.test(key) && typeof value === 'string' && value)
      .map(([, value]) => value);
    this.secrets = [...new Set(values.flatMap(value => {
      let encoded = value;
      try { encoded = encodeURIComponent(value); } catch {}
      return [value, encoded, JSON.stringify(value).slice(1, -1)];
    }))]
      .sort((a, b) => b.length - a.length);
    this.overlap = Math.max(0, ...this.secrets.map(value => value.length - 1));
    this.matcher = this.secrets.length ? new RegExp(this.secrets.map(value =>
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
    this.maxChars = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 4000;
    this.tail = '';
    this.pending = '';
    this.decoder = new StringDecoder('utf8');
  }

  redact(value) {
    return this.matcher ? String(value).replace(this.matcher, '[redacted]') : String(value);
  }

  append(chunk) {
    const text = this.pending + this.decoder.write(chunk);
    // Retain enough overlap to match credentials split across stderr chunks.
    let boundary = Math.max(0, text.length - this.overlap);
    if (this.matcher) {
      for (const match of text.matchAll(this.matcher)) {
        if (match.index < boundary && match.index + match[0].length > boundary) {
          boundary = match.index;
          break;
        }
      }
    }
    this.tail = (this.tail + this.redact(text.slice(0, boundary))).slice(-this.maxChars);
    this.pending = text.slice(boundary);
  }

  end() {
    const text = this.tail + this.redact(this.pending + this.decoder.end());
    this.tail = text.slice(-this.maxChars);
    this.pending = '';
  }

  text() {
    return (this.tail + this.redact(this.pending)).slice(-this.maxChars);
  }

  error(error) {
    const message = this.redact(error instanceof Error ? error.message : error);
    const safe = new Error(message);
    safe.name = error?.name || 'Error';
    if (error?.code !== undefined) safe.code = typeof error.code === 'string' ? this.redact(error.code) : error.code;
    return safe;
  }
}
