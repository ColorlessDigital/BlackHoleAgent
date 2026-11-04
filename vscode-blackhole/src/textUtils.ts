// P1-6: pure helpers extracted from extension.ts (no vscode import).
// Unit-testable in isolation; extension.ts re-exports thin wrappers.

export type StreamEventLike = {
  type?: string;
  text?: string;
  status?: string;
  error?: string;
  tool?: string;
  state?: string;
  log?: string;
  outcome?: { status: string; reason?: string };
};

export function statusIcon(status: string): string {
  if (status === 'reviewed') return '$(git-pull-request)';
  if (status === 'accepted') return '$(check)';
  if (status === 'rejected') return '$(close)';
  if (status === 'rolled_back') return '$(history)';
  if (status.includes('failed')) return '$(warning)';
  return '$(diff)';
}

export function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function formatAgentStreamEvent(event: StreamEventLike): string {
  if (event.type === 'chunk' && event.text) return `[agent] ${event.text}`;
  if (event.type === 'status' && event.status) return `[status] ${event.status}`;
  if (event.type === 'tool_start') return `[tool] start ${event.tool || 'unknown'}`;
  if (event.type === 'tool_end') return `[tool] end ${event.tool || 'unknown'}`;
  if (event.type === 'terminal_log' && event.log) return `[terminal] ${event.log}`;
  if (event.type === 'state_change' && event.state) return `[state] ${event.state}`;
  if (event.type === 'error') return `[error] ${event.error || 'BlackHole stream error.'}`;
  if (event.type === 'end') return `[agent] task ${event.outcome?.status || 'finished'}`;
  return '';
}

export function compactStatusText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function buildEmptyChatFallback(toolEventCount: number, lastStatus: string, streamError: string): string {
  const lines = [
    'BlackHole finished the run, but the model did not return a visible chat summary.',
    `Tool events observed: ${toolEventCount}.`
  ];
  if (lastStatus) lines.push(`Last status: ${compactStatusText(lastStatus)}.`);
  if (streamError) lines.push(`Stream error: ${compactStatusText(streamError)}.`);
  lines.push('Open the BlackHole output log or execution timeline for the detailed tool trace.');
  return lines.join('\n');
}

export function stripMarkdownCodeFence(raw: string): string {
  const text = String(raw || '').trim();
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trimEnd() : text;
}

export function cleanInlineSuggestion(raw: string): string {
  const value = stripMarkdownCodeFence(raw).replace(/\r\n/g, '\n');
  if (!value.trim()) return '';
  return value.slice(0, 2000);
}

export function normalizeReplacementForRange(raw: string, selectedCode: string): string {
  let replacement = stripMarkdownCodeFence(raw).replace(/\r\n/g, '\n');
  if (selectedCode.endsWith('\n') && !replacement.endsWith('\n')) replacement += '\n';
  if (!selectedCode.endsWith('\n')) replacement = replacement.replace(/\n+$/, '');
  return replacement;
}

export function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Pure part of getCandidateBaseUrls (no vscode dependency).
export function getCandidateBaseUrlsFrom(configured: string): string[] {
  const base = String(configured || 'http://127.0.0.1:3003').replace(/\/+$/, '');
  const candidates = new Set<string>([base]);
  try {
    const url = new URL(base);
    const port = Number(url.port || 80);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      for (let offset = 0; offset < 20; offset += 1) {
        url.port = String(port + offset);
        candidates.add(url.toString().replace(/\/+$/, ''));
      }
    }
  } catch {
    candidates.add('http://127.0.0.1:3003');
  }
  return Array.from(candidates);
}
