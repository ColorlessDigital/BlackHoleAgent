import type { ApiBootstrap, ApiClient, StreamEvent } from '../types.ts';

export async function bootstrapApi(): Promise<ApiBootstrap> {
  if (typeof window !== 'undefined' && window.blackhole?.getApiConfig) {
    try {
      const config = await window.blackhole.getApiConfig();
      if (config) return config;
    } catch (e) {
      console.warn('Electron IPC bootstrap failed, falling back to HTTP:', e);
    }
  }

  const candidateUrls = ['http://127.0.0.1:3003/api/bootstrap'];

  if (typeof window !== 'undefined' && (window.location.origin.includes('127.0.0.1') || window.location.origin.includes('localhost'))) {
    const sameOriginUrl = `${window.location.origin}/api/bootstrap`;
    if (!window.location.origin.endsWith(':5173')) {
      candidateUrls.unshift(sameOriginUrl);
    } else {
      candidateUrls.push(sameOriginUrl);
    }
  }

  for (const url of Array.from(new Set(candidateUrls))) {
    try {
      const response = await fetch(url);
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('application/json')) {
        continue;
      }
      return (await response.json()) as ApiBootstrap;
    } catch {
      // Try the next bootstrap candidate.
    }
  }

  throw new Error('Failed to bootstrap API gateway session: Connection refused.');
}

// Pure SSE line parser (testable without fetch).
// Returns { kind: 'ignore' } | { kind: 'done' } | { kind: 'event', event }.
export type SseParsed =
  | { kind: 'ignore' }
  | { kind: 'done' }
  | { kind: 'event'; event: StreamEvent };

export function parseSseLine(line: string): SseParsed {
  if (!line || !line.trim()) return { kind: 'ignore' };
  if (!line.startsWith('data: ')) return { kind: 'ignore' };
  const dataStr = line.slice(6).trim();
  if (dataStr === '[DONE]') return { kind: 'done' };
  try {
    return { kind: 'event', event: JSON.parse(dataStr) as StreamEvent };
  } catch {
    return { kind: 'ignore' };
  }
}

export async function consumeAgentEvents(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    throw new Error('Agent returned a non-streaming response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let ended = false;
  const dispatch = () => {
    if (!data.length || ended) return;
    const parsed = parseSseLine(`data: ${data.join('\n')}`);
    data = [];
    if (parsed.kind === 'done') { ended = true; onEvent({ type: 'end' }); return; }
    if (parsed.kind !== 'event' || !parsed.event || Array.isArray(parsed.event) || typeof parsed.event.type !== 'string') {
      throw new Error('Agent returned an invalid stream event.');
    }
    if (parsed.event.type === 'end') ended = true;
    onEvent(parsed.event);
  };
  const line = (value: string) => {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value) { dispatch(); return; }
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    while (!ended) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while (!ended && (newline = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) {
        if (!ended && buffer) line(buffer);
        dispatch();
        break;
      }
    }
    if (!ended) throw new Error('Agent stream ended before completion.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createApiClient({ baseUrl, token }: ApiBootstrap): ApiClient {
  return {
    baseUrl,
    token,
    // NOTE: EventSource (used for /api/events) cannot send headers, so the
    // session token stays in the query string ONLY for this endpoint.
    // All other calls use the x-blackhole-token header (see request/stream).
    // P2-8: server only accepts ?token on /api/events.
    eventsUrl: `${baseUrl}/api/events?token=${encodeURIComponent(token)}`,

    async request<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
      const url = `${this.baseUrl}/api${path}`;
      const headers = {
        'Content-Type': 'application/json',
        'x-blackhole-token': this.token,
        ...(options.headers || {})
      };

      const response = await fetch(url, {
        ...options,
        headers
      });

      if (response.status === 401) {
        throw new Error('API request unauthorized: Invalid session token.');
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        const errorText = errData?.error || errData?.message || `API error (${response.status})`;
        throw new Error(errorText);
      }

      return (await response.json()) as T;
    },

    async stream(path: string, body: unknown, onEvent: (event: StreamEvent) => void): Promise<void> {
      const url = `${this.baseUrl}/api${path}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-blackhole-token': this.token
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`Stream start failed: ${response.status}`);
      }

      await consumeAgentEvents(response, onEvent);
    }
  };
}
