import fs from 'fs';
import path from 'path';

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-/.:]+/i)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function stableId(prefix = 'mem') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class AgentMemoryStore {
  constructor({
    workspaceRoot = '.',
    memoryPath = null,
    retentionLimit = 200
  } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.memoryPath = memoryPath || path.join(this.workspaceRoot, 'data', 'agent-memory.json');
    this.retentionLimit = Math.max(20, Number(retentionLimit) || 200);
  }

  load() {
    try {
      if (!fs.existsSync(this.memoryPath)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  save(entries = []) {
    const safeEntries = entries
      .filter(entry => entry && typeof entry === 'object')
      .slice(-this.retentionLimit);

    fs.mkdirSync(path.dirname(this.memoryPath), { recursive: true });
    fs.writeFileSync(
      this.memoryPath,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: safeEntries
      }, null, 2),
      'utf8'
    );
    return safeEntries;
  }

  append(entry = {}) {
    const normalized = this.normalizeEntry(entry);
    const entries = this.load();
    entries.push(normalized);
    this.save(entries);
    return normalized;
  }

  recordRun({
    goal = '',
    changedFiles = [],
    verification = null,
    toolFailures = [],
    loopGuardEvents = [],
    taskGraph = null,
    status = 'completed'
  } = {}) {
    const fileText = changedFiles.length > 0
      ? ` Changed files: ${changedFiles.slice(0, 12).join(', ')}.`
      : ' No file changes were recorded.';
    const verificationText = verification
      ? ` Verification: ${verification}.`
      : '';
    const failureText = toolFailures.length > 0
      ? ` Tool failures: ${toolFailures.map(failure => failure.tool || failure.reason).join(', ')}.`
      : '';
    const loopText = loopGuardEvents.length > 0
      ? ` Loop guard events: ${loopGuardEvents.length}.`
      : '';
    const graphText = taskGraph?.summary ? ` Task graph: ${taskGraph.summary}.` : '';

    return this.append({
      type: 'run_summary',
      summary: `Goal: ${goal || 'unspecified'}. Status: ${status}.${fileText}${verificationText}${failureText}${loopText}${graphText}`,
      tags: [
        'run',
        status,
        ...changedFiles.map(file => `file:${file}`),
        ...(toolFailures || []).map(failure => `tool:${failure.tool || 'unknown'}`)
      ],
      source: 'agent_state_machine'
    });
  }

  search(query = '', { limit = 8 } = {}) {
    const entries = this.load();
    const queryTokens = tokenize(query);
    const max = Math.max(1, Math.min(50, Number(limit) || 8));

    if (queryTokens.length === 0) {
      return entries
        .slice(-max)
        .reverse()
        .map(entry => ({ ...entry, score: 0 }));
    }

    const scored = entries.map(entry => {
      const text = [
        entry.summary,
        ...(entry.tags || []),
        entry.type,
        entry.source
      ].join(' ');
      const tokens = tokenize(text);
      const tokenSet = new Set(tokens);
      let score = 0;

      for (const queryToken of queryTokens) {
        if (tokenSet.has(queryToken)) {
          score += 3;
        }
        for (const token of tokenSet) {
          if (token.includes(queryToken) || queryToken.includes(token)) {
            score += 1;
            break;
          }
        }
      }

      return { ...entry, score };
    });

    return scored
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, max);
  }

  getRecent(limit = 8) {
    return this.load().slice(-(Number(limit) || 8)).reverse();
  }

  buildPromptSection(query = '', limit = 8) {
    const entries = this.search(query, { limit });
    if (entries.length === 0) {
      return '';
    }

    const lines = entries.map((entry, index) => {
      const tags = entry.tags?.length ? ` [${entry.tags.slice(0, 6).join(', ')}]` : '';
      return `${index + 1}. (${entry.type || 'note'}) ${entry.summary}${tags}`;
    });

    return `[Project Memory]\nRelevant prior project notes:\n${lines.join('\n')}`;
  }

  normalizeEntry(entry = {}) {
    const summary = String(entry.summary || '').trim().slice(0, 4000);
    const tags = Array.isArray(entry.tags)
      ? entry.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 40)
      : [];

    return {
      id: entry.id || stableId('mem'),
      timestamp: entry.timestamp || new Date().toISOString(),
      type: String(entry.type || 'note').trim() || 'note',
      summary: summary || 'No summary provided.',
      tags,
      source: String(entry.source || 'manual').trim() || 'manual'
    };
  }
}
