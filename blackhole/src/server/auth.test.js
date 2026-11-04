import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import { createAuthMiddleware, createSession } from './auth.js';

test('mounted API auth accepts the events query token only on its intended route', async () => {
  const session = createSession();
  const app = express();
  app.use('/api', createAuthMiddleware(session));
  app.get('/api/:route', (_req, res) => res.json({ ok: true }));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const status = (route, headers = {}) => new Promise((resolve, reject) => {
    // HTTP middleware coverage must not depend on fetch's browser-style port blacklist.
    http.get(`${baseUrl}${route}`, { headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
  try {
    assert.equal(await status('/health'), 200);
    assert.equal(await status('/bootstrap'), 200);
    assert.equal(await status(`/events?token=${session.token}`), 200);
    assert.equal(await status('/events?token=invalid'), 401);
    assert.equal(await status(`/config?token=${session.token}`), 401);
    assert.equal(await status('/config'), 401);
    assert.equal(await status('/config', { 'x-blackhole-token': session.token }), 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
