import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpInspector } from './httpInspector.js';
import { SearchService } from './SearchService.js';
import { DuckDuckGoProvider } from './providers/DuckDuckGoProvider.js';
import { TavilyProvider } from './providers/TavilyProvider.js';
import { ExaProvider } from './providers/ExaProvider.js';
import { BraveProvider } from './providers/BraveProvider.js';
import { FirecrawlProvider } from './providers/FirecrawlProvider.js';
import { Crawler } from './crawler.js';
import { HtmlInspector } from './htmlInspector.js';

async function stalledBody(t) {
  let response;
  let ready;
  const headers = new Promise(resolve => { ready = resolve; });
  const server = http.createServer((_req, res) => {
    response = res;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<html><body>');
    ready();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { response?.end(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, headers, end: () => response?.end() };
}

test('HTTP timeout covers a stalled body after headers, not only connection setup', async t => {
  const server = await stalledBody(t);
  const pending = HttpInspector.fetch({ url: server.url }, { webRequestTimeoutMs: 40 });
  const result = await Promise.race([pending, delay(400, null)]);
  server.end();
  await pending;
  assert.ok(result, 'The body exceeded the configured timeout and never settled.');
  assert.equal(result.ok, false);
});

test('HTTP body cancellation stops the request instead of producing saved evidence', async t => {
  const server = await stalledBody(t);
  const stop = new AbortController();
  const reason = new Error('fixture-stop');
  const pending = HttpInspector.fetch({ url: server.url }, {}, { abortSignal: stop.signal })
    .then(value => ({ value }), error => ({ error }));
  await server.headers;
  stop.abort(reason);
  const result = await Promise.race([pending, delay(400, null)]);
  server.end();
  await pending;
  assert.equal(result?.error, reason);
});

test('DuckDuckGo has an absolute timeout even when no response headers arrive', async t => {
  let request;
  t.mock.method(https, 'get', options => {
    request = new EventEmitter();
    request.end = () => {};
    request.destroy = error => request.emit('error', error || new Error('destroyed'));
    options.signal?.addEventListener('abort', () => request.destroy(options.signal.reason), { once: true });
    return request;
  });
  const pending = DuckDuckGoProvider.search('fixture', { webRequestTimeoutMs: 40 });
  const result = await Promise.race([pending, delay(400, null)]);
  if (!result) request.destroy();
  await pending;
  assert.ok(result, 'Search never settled while waiting for headers.');
  assert.equal(result.ok, false);
});

test('a cancelled provider request never starts a DuckDuckGo fallback', async t => {
  let fallbackCalls = 0;
  const stop = new AbortController();
  const reason = new Error('fixture-search-stop');
  t.mock.method(TavilyProvider, 'search', async () => { stop.abort(reason); return { ok: false, error: 'Cancelled' }; });
  t.mock.method(DuckDuckGoProvider, 'search', async () => { fallbackCalls++; return { ok: true, results: [] }; });
  const outcome = await SearchService.search({ query: 'fixture', provider: 'tavily' }, { tavilyApiKey: 'fixture' }, { abortSignal: stop.signal })
    .then(value => ({ value }), error => ({ error }));
  assert.equal(fallbackCalls, 0);
  assert.equal(outcome.error, reason);
});

for (const [name, Provider, key] of [['tavily', TavilyProvider, 'tavilyApiKey'], ['exa', ExaProvider, 'exaApiKey'],
  ['brave', BraveProvider, 'braveApiKey'], ['firecrawl', FirecrawlProvider, 'firecrawlApiKey']]) {
  test(`${name} forwards cancellation through body reading without converting it to a provider failure`, async t => {
    const stop = new AbortController();
    const reason = new Error('fixture-provider-stop');
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    let release;
    t.mock.method(globalThis, 'fetch', async (_url, options) => ({ ok: true,
      json: () => new Promise((resolve, reject) => {
        release = () => resolve({});
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        started();
      }) }));
    const pending = Provider.search('fixture', { [key]: 'fixture' }, { abortSignal: stop.signal })
      .then(value => ({ value }), error => ({ error }));
    await waiting;
    stop.abort(reason);
    const result = await Promise.race([pending, delay(200, null)]);
    release();
    await pending;
    assert.equal(result?.error, reason);
  });
}

test('crawl cancellation interrupts the inter-page delay and does not fetch another page', async t => {
  let calls = 0;
  const stop = new AbortController();
  const reason = new Error('fixture-crawl-stop');
  t.mock.method(HtmlInspector, 'inspect', async ({ url }) => {
    calls++;
    return { ok: true, html: { title: 'Fixture', links: [`${url}child`] }, findings: [] };
  });
  const pending = Crawler.crawl({ url: 'https://fixture.example/', limit: 2 }, { webCrawlerDelayMs: 100 }, { abortSignal: stop.signal })
    .then(value => ({ value }), error => ({ error }));
  await delay(10);
  stop.abort(reason);
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.error, reason);
});
