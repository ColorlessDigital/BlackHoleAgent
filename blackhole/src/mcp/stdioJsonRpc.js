import { EventEmitter } from 'events';

export class StdioJsonRpcPeer extends EventEmitter {
  constructor({ input, output, name = 'mcp-peer', framing = 'auto' } = {}) {
    super();
    this.input = input;
    this.output = output;
    this.name = name;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.closeError = null;
    this.autoFraming = framing === 'auto';
    this.writeFraming = framing === 'content-length' ? framing : 'newline';
    this.onData = chunk => this.handleData(chunk);
    this.onEnd = () => this.close(new Error(`${this.name} transport closed (EOF).`));
    this.onError = error => this.close(error);
    this.input?.on('data', this.onData);
    this.input?.on('end', this.onEnd);
    this.input?.on('close', this.onEnd);
    this.input?.on('error', this.onError);
    this.output?.on('error', this.onError);
  }

  request(method, params = {}, { timeoutMs = 30000, signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(this.closeError);
    const id = this.nextId;
    this.nextId += 1;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const cancel = (error, reason) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.reject(error);
        // Initialization is shared and must never receive a cancellation notification.
        if (method !== 'initialize' && !this.closed) {
          try { this.notify('notifications/cancelled', { requestId: id, reason }); } catch {}
        }
      };
      const onAbort = () => cancel(signal.reason, 'Caller stopped waiting for the request.');
      const timer = setTimeout(() => cancel(
        new Error(`${this.name} request timed out: ${method}`), 'Request deadline exceeded.'
      ), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        method,
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); }
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.send(message);
      } catch (error) {
        this.pending.get(id)?.reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({
      jsonrpc: '2.0',
      method,
      params
    });
  }

  respond(id, result) {
    this.send({
      jsonrpc: '2.0',
      id,
      result
    });
  }

  respondError(id, code, message, data = undefined) {
    this.send({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data })
      }
    });
  }

  send(message) {
    if (this.closed) throw this.closeError;
    const payload = JSON.stringify(message);
    const wire = this.writeFraming === 'content-length'
      ? `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`
      : `${payload}\n`;
    this.output.write(wire, error => { if (error) this.close(error); });
  }

  handleData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    try {
      while (this.buffer.length > 0) {
        if ([0x20, 0x09, 0x0a, 0x0d].includes(this.buffer[0])) {
          this.buffer = this.buffer.subarray(1);
          continue;
        }
        const isLine = this.buffer[0] === 0x7b || this.buffer[0] === 0x5b;
        const packet = isLine ? this.tryReadLineMessage() : this.tryReadFramedMessage();
        if (!packet) return;
        if (this.autoFraming) this.writeFraming = isLine ? 'newline' : 'content-length';
        this.dispatchMessage(packet.message);
      }
    } catch {
      this.close(new Error(`${this.name} received invalid JSON-RPC framing or JSON.`));
    }
  }

  tryReadFramedMessage() {
    const start = this.buffer.subarray(0, 15).toString('ascii').toLowerCase();
    if (!['content-length:', 'content-type:'].some(prefix => prefix.startsWith(start) || start.startsWith(prefix))) {
      throw new Error('Invalid JSON-RPC header.');
    }
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;

    const header = this.buffer.slice(0, headerEnd).toString('utf8');
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) throw new Error('Missing Content-Length.');

    const length = Number(lengthMatch[1]);
    if (!Number.isSafeInteger(length)) throw new Error('Invalid Content-Length.');
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + length;
    if (this.buffer.length < messageEnd) return null;

    const payload = this.buffer.slice(messageStart, messageEnd).toString('utf8');
    this.buffer = this.buffer.slice(messageEnd);
    return { message: JSON.parse(payload) };
  }

  tryReadLineMessage() {
    const firstByte = this.buffer[0];
    if (firstByte !== 0x7b && firstByte !== 0x5b) return null;
    const newline = this.buffer.indexOf('\n');
    if (newline === -1) return null;
    const payload = this.buffer.slice(0, newline).toString('utf8').trim();
    this.buffer = this.buffer.slice(newline + 1);
    if (!payload) return null;
    return { message: JSON.parse(payload) };
  }

  dispatchMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid JSON-RPC message.');
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) {
        pending.reject(new Error(message.error.message || `${pending.method} failed`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.emit('request', message);
    }
  }

  close(error = new Error(`${this.name} transport closed.`)) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    this.buffer = Buffer.alloc(0);
    this.input?.off('data', this.onData);
    this.input?.off('end', this.onEnd);
    this.input?.off('close', this.onEnd);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('close', error);
  }
}
