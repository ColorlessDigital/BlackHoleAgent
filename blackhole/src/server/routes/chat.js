import express from 'express';
import fs from 'fs';
import path from 'path';
import { runAgentSession } from '../../agent/orchestrator.js';
import { runCollaborativeSession } from '../../agent/collaborator.js';
import { AgentCheckpointStore } from '../../agent/core/checkpointStore.js';
import { COMPACTION_SYSTEM_PROMPT, compactConversation, compactionTranscriptBudget } from '../../agent/contextCompactor.js';
import { callLocalModel } from '../../agent/llmRouter.js';
import { resolveModelRoute } from '../../agent/modelRouting.js';
import { loadConfig } from '../../config/configStore.js';
import { PROJECT_ROOT } from '../../common/paths.js';

// Setup paths for chat history in CONFIG_DIR or fallback
const CONFIG_DIR = process.env.BLACKHOLE_DATA_DIR || (
  PROJECT_ROOT.toLowerCase().includes('.asar')
    ? path.join(process.env.APPDATA || process.env.LOCALAPPDATA || path.dirname(PROJECT_ROOT), 'BlackHole')
    : path.join(PROJECT_ROOT, 'data')
);
const CHATS_HISTORY_PATH = path.join(CONFIG_DIR, 'chats_history.json');
const WORKSPACE_MIGRATE_PATH = path.join(PROJECT_ROOT, 'chats_history.json');

function loadChatsHistory() {
  try {
    if (fs.existsSync(CHATS_HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(CHATS_HISTORY_PATH, 'utf-8'));
    }
    // Migrate from old workspace root if present
    if (fs.existsSync(WORKSPACE_MIGRATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(WORKSPACE_MIGRATE_PATH, 'utf-8'));
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      fs.writeFileSync(CHATS_HISTORY_PATH, JSON.stringify(data, null, 2), 'utf-8');
      return data;
    }
  } catch (e) {
    console.error('Error loading chat history:', e);
  }
  return [];
}

function saveChatsHistory(chats) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CHATS_HISTORY_PATH, JSON.stringify(chats, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Error saving chat history:', e);
    return false;
  }
}

export function createChatRouter() {
  const router = express.Router();
  const checkpointStore = new AgentCheckpointStore();

  // Single Agent Session Chat stream
  router.post('/chat', async (req, res) => {
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (data) => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {}
      }
    };
    await runAgentSession({
      messages: req.body.messages || [],
      send,
      providerSessionId: req.body.providerSessionId,
      abortSignal: abortController.signal
    });
    if (!res.writableEnded) res.end();
  });

  router.post('/chat/resume-checkpoint', async (req, res) => {
    const sessionId = req.body.sessionId || 'latest';
    const checkpoint = sessionId === 'latest'
      ? checkpointStore.loadLatest()
      : checkpointStore.load(sessionId);

    if (!checkpoint) {
      return res.status(404).json({ error: 'Agent checkpoint not found.' });
    }

    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (data) => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {}
      }
    };
    await runAgentSession({
      messages: req.body.messages || [],
      send,
      resumeCheckpoint: checkpoint,
      providerSessionId: req.body.providerSessionId,
      abortSignal: abortController.signal
    });
    if (!res.writableEnded) res.end();
  });

  // Multi-Agent Collaborative Session Chat stream
  router.post('/agent/collaborate', async (req, res) => {
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (data) => {
      if (!res.writableEnded && !abortController.signal.aborted) {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {}
      }
    };
    const { topic, agents } = req.body;
    await runCollaborativeSession({
      topic,
      agents,
      send,
      providerSessionId: req.body.providerSessionId,
      abortSignal: abortController.signal
    });
    if (!res.writableEnded) res.end();
  });

  // Manual context compaction: summarize the middle of a long conversation so
  // the session keeps working past the context limit. Stateless — the caller
  // replaces its message list with the returned one.
  router.post('/chat/compress', async (req, res) => {
    try {
      const config = loadConfig();
      const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
      const systemPrompt = String(req.body.systemPrompt || '');
      const limitTokens = Number(req.body.contextLimit) || Number(config.contextLimit) || 8192;
      let summary = '';
      const result = await compactConversation({
        messages,
        systemPrompt,
        limitTokens,
        transcriptLimitTokens: compactionTranscriptBudget(resolveModelRoute(config, { phase: 'summarize' }).contextLimit),
        threshold: 0, // manual request: always attempt when long enough
        summarize: async (transcript) => {
          await callLocalModel(
            config,
            COMPACTION_SYSTEM_PROMPT,
            [{ role: 'user', content: transcript }],
            (chunk) => { summary += chunk || ''; },
            { phase: 'summarize', task: 'context-compaction', usageTag: 'compaction', sessionId: req.body.providerSessionId }
          );
          return summary;
        }
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, compacted: false, error: err.message });
    }
  });

  // GET session histories
  router.get('/chats', (_req, res) => {
    res.json(loadChatsHistory());
  });

  // POST save session history
  router.post('/chats/save', (req, res) => {
    const { id, title, messages } = req.body;
    if (!id) return res.status(400).json({ error: 'Session ID required.' });
    
    const chats = loadChatsHistory();
    const existingIndex = chats.findIndex(c => c.id === id);
    
    const session = {
      id,
      title: title || `대화 세션 - ${new Date(id).toLocaleString()}`,
      messages: messages || []
    };
    
    if (existingIndex >= 0) {
      chats[existingIndex] = session;
    } else {
      chats.unshift(session);
    }
    
    const success = saveChatsHistory(chats);
    res.json({ success, session });
  });

  // DELETE session history
  router.delete('/chats/:id', (req, res) => {
    const targetId = parseInt(req.params.id) || req.params.id;
    const chats = loadChatsHistory();
    const filtered = chats.filter(c => c.id !== targetId);
    const success = saveChatsHistory(filtered);
    res.json({ success });
  });

  return router;
}
