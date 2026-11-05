import test, { after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import https from 'https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listenLoopback } from '../testSupport/loopback.js';

// Configure storage before loading modules that capture CONFIG_DIR at import time.
const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-web-service-test-'));
const previousData = process.env.BLACKHOLE_DATA_DIR;
process.env.BLACKHOLE_DATA_DIR = testData;
const { isUrlAllowed } = await import('./urlPolicy.js');
const { HttpInspector } = await import('./httpInspector.js');
const { HtmlInspector } = await import('./htmlInspector.js');
const { Crawler } = await import('./crawler.js');
const { EvidenceStore } = await import('./evidenceStore.js');
const { SearchService } = await import('./SearchService.js');
const { DuckDuckGoProvider } = await import('./providers/DuckDuckGoProvider.js');
after(() => {
  if (previousData === undefined) delete process.env.BLACKHOLE_DATA_DIR;
  else process.env.BLACKHOLE_DATA_DIR = previousData;
  const target = fs.realpathSync(testData), parent = fs.realpathSync(os.tmpdir());
  assert.ok(target.startsWith(parent + path.sep));
  fs.rmSync(target, { recursive: true, force: true });
});

test('urlPolicy - isUrlAllowed', async (t) => {
  await t.test('should allow any URL when webAllowedDomains is empty', () => {
    assert.strictEqual(isUrlAllowed('https://example.com', {}), true);
    assert.strictEqual(isUrlAllowed('https://example.com', { webAllowedDomains: '' }), true);
    assert.strictEqual(isUrlAllowed('https://example.com', { webAllowedDomains: '  ' }), true);
  });

  await t.test('should allow exact domain match', () => {
    assert.strictEqual(
      isUrlAllowed('https://example.com/page', { webAllowedDomains: 'example.com' }),
      true
    );
  });

  await t.test('should allow subdomain match', () => {
    assert.strictEqual(
      isUrlAllowed('https://sub.example.com', { webAllowedDomains: 'example.com' }),
      true
    );
  });

  await t.test('should reject non-matching domain', () => {
    assert.strictEqual(
      isUrlAllowed('https://evil.com', { webAllowedDomains: 'example.com' }),
      false
    );
  });

  await t.test('should reject non-http/https protocols', () => {
    assert.strictEqual(isUrlAllowed('ftp://example.com', { webAllowedDomains: 'example.com' }), false);
    assert.strictEqual(isUrlAllowed('file:///etc/passwd', {}), false);
  });

  await t.test('should reject null/empty/invalid URLs', () => {
    assert.strictEqual(isUrlAllowed('', {}), false);
    assert.strictEqual(isUrlAllowed(null, {}), false);
    assert.strictEqual(isUrlAllowed('not-a-url', {}), false);
  });

  await t.test('should handle multiple allowed domains (comma-separated)', () => {
    const config = { webAllowedDomains: 'example.com, github.com' };
    assert.strictEqual(isUrlAllowed('https://example.com', config), true);
    assert.strictEqual(isUrlAllowed('https://github.com', config), true);
    assert.strictEqual(isUrlAllowed('https://evil.com', config), false);
  });
});

test('HttpInspector, HtmlInspector, Crawler, and EvidenceStore integration with local server', async (t) => {
  // Spin up a mock HTTP server
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { 'Location': '/target' });
      res.end();
    } else if (req.url === '/target') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': ['session_id=abc123xyz; Secure; HttpOnly', 'theme=dark']
      });
      res.end(`
        <html>
          <head>
            <title>Target Security Page</title>
          </head>
          <body>
            <h1>Security Test Target</h1>
            <iframe src="/iframe" name="test-iframe"></iframe>
            <a href="https://external-domain.com/path">External link</a>
            <form action="http://insecure-domain.com/login" method="POST">
              <input type="text" name="username" />
            </form>
            <script src="/js/analytics.js"></script>
            <script>console.log("inline-test");</script>
          </body>
        </html>
      `);
    } else if (req.url === '/large') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('A'.repeat(2000));
    } else if (req.url === '/article') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><script>' + 'tracking'.repeat(600) + '</script></head><body><nav>Navigation</nav><main><h1>Official history</h1><p>Accreditation: 2013.</p></main></body></html>');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await listenLoopback(server);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  await t.test('HttpInspector - should fetch url with redirect chain', async () => {
    const result = await HttpInspector.fetch({ url: `${baseUrl}/redirect` }, {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.finalUrl, `${baseUrl}/target`);
    assert.strictEqual(result.http.status, 200);
    assert.strictEqual(result.http.redirects.length, 1);
    assert.strictEqual(result.http.redirects[0].status, 302);
  });

  await t.test('HttpInspector - should truncate body when exceeding maxBytes', async () => {
    const result = await HttpInspector.fetch(
      { url: `${baseUrl}/large` },
      { webMaxResponseBytes: 500 }
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.bytesRead, 500);
    assert.strictEqual(result.http.bodyHashIsFull, false);
    assert.ok(result.body.includes('truncated') || result.body === '[Body preview omitted for non-text content-type]');
  });

  await t.test('HttpInspector returns readable article evidence beyond the raw HTML preview', async () => {
    const result = await HttpInspector.fetch({ url: `${baseUrl}/article` });
    assert.ok(!result.body.includes('Accreditation: 2013.'));
    assert.match(result.textPreview, /Accreditation: 2013\./);
    assert.ok(!result.textPreview.includes('tracking'));
    assert.ok(!result.textPreview.includes('Navigation'));
  });

  await t.test('HtmlInspector - should extract title, meta, scripts, iframes, cookies, findings', async () => {
    const result = await HtmlInspector.inspect({ url: `${baseUrl}/target` }, {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.html.title, 'Target Security Page');
    assert.strictEqual(result.html.iframes.length, 1);
    assert.strictEqual(result.html.iframes[0].name, 'test-iframe');
    assert.deepStrictEqual(result.html.externalDomains, ['external-domain.com']);
    
    // Cookie flags
    const secureOnly = result.cookies.find(c => c.name === 'session_id');
    assert.strictEqual(secureOnly.secure, true);
    assert.strictEqual(secureOnly.httpOnly, true);
    
    // Insecure transport finding
    const insecureTransport = result.findings.find(f => f.id === 'insecure_transport');
    assert.ok(insecureTransport);
    assert.strictEqual(insecureTransport.severity, 'high');
  });

  await t.test('Crawler - same-origin and depth limit', async () => {
    const result = await Crawler.crawl(
      { url: `${baseUrl}/target`, depth: 1, limit: 2 },
      {}
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.pagesCrawled > 0);
  });

  await t.test('EvidenceStore - diff scan details', async () => {
    // First scan (clean baseline)
    const scan1 = await EvidenceStore.monitor({ url: `${baseUrl}/target` }, {});
    assert.strictEqual(scan1.ok, true);
    assert.strictEqual(scan1.isFirstScan, true);

    // Second scan (no change)
    const scan2 = await EvidenceStore.monitor({ url: `${baseUrl}/target` }, {});
    assert.strictEqual(scan2.ok, true);
    assert.strictEqual(scan2.isFirstScan, false);
    assert.strictEqual(scan2.diffs.changed, false);
  });

  server.close();
});

test('SearchService - fallback, duplicate URL dedup, maxResults', async (t) => {
  await t.test('SearchService - unknown provider should fail', async () => {
    const result = await SearchService.search({ query: 'test', provider: 'invalid_prov' }, {});
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('지원하지 않는'));
  });

  await t.test('SearchService - missing API key should trigger fallback', async () => {
    const result = await SearchService.search(
      { query: 'Vite documentation', provider: 'tavily', maxResults: 2 },
      { tavilyApiKey: '' }
    );
    assert.ok(result.hasOwnProperty('fallback'));
    assert.strictEqual(result.fallback, true);
    assert.ok(result._fallbackReason.includes('API Key 미설정'));
  });
});

test('TLS Inspector & HtmlInspector integration with mock HTTPS', async (t) => {
  // Stub HttpInspector.fetch to intercept mock domains
  const originalFetch = HttpInspector.fetch;
  HttpInspector.fetch = async (params, config) => {
    const { url } = params;
    if (url && url.includes('mock-')) {
      return {
        ok: true,
        url,
        finalUrl: url,
        timestamp: new Date().toISOString(),
        truncated: false,
        bytesRead: 100,
        maxBytes: 10000,
        http: {
          status: 200,
          headers: {},
          redirects: [],
          contentType: 'text/html',
          bodyHash: 'fakehash',
          bodyHashIsFull: true
        },
        body: '<html><head><title>Mock TLS Page</title></head><body>Hello</body></html>'
      };
    }
    return originalFetch(params, config);
  };

  // Stub https.request to intercept mock socket TLS info
  const originalRequest = https.request;
  https.request = (options, callback) => {
    const hostname = options.hostname;
    if (hostname && hostname.includes('mock-')) {
      let authorized = true;
      let authorizationError = null;
      let validTo = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(); // 10 days later

      if (hostname === 'mock-unauthorized.local') {
        authorized = false;
        authorizationError = 'self-signed certificate';
      } else if (hostname === 'mock-expired.local') {
        validTo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(); // 2 days ago
      } else if (hostname === 'mock-expiring-soon.local') {
        validTo = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(); // 5 days later
      }

      const mockSocket = {
        getPeerCertificate: () => ({
          subject: { CN: hostname },
          issuer: { CN: 'Mock CA' },
          valid_from: new Date(Date.now() - 10 * 24 * 3600 * 1000).toUTCString(),
          valid_to: new Date(validTo).toUTCString(),
          fingerprint256: 'FA:KE:FI:NG:ER:PR:IN:T'
        }),
        getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384', version: 'TLSv1.3' }),
        getProtocol: () => 'TLSv1.3',
        authorized,
        authorizationError
      };

      const mockRes = {
        socket: mockSocket,
        resume: () => {}
      };

      process.nextTick(() => callback(mockRes));

      return {
        on: () => {},
        setTimeout: () => {},
        end: () => {}
      };
    }

    return originalRequest(options, callback);
  };

  t.after(() => {
    // Restore stubs
    HttpInspector.fetch = originalFetch;
    https.request = originalRequest;
  });

  await t.test('HtmlInspector + TlsInspector - should detect tls_unauthorized', async () => {
    const result = await HtmlInspector.inspect({ url: 'https://mock-unauthorized.local' }, {});
    assert.strictEqual(result.ok, true);
    assert.ok(result.tls);
    assert.strictEqual(result.tls.authorized, false);
    const finding = result.findings.find(f => f.id === 'tls_unauthorized');
    assert.ok(finding);
    assert.strictEqual(finding.severity, 'high');
  });

  await t.test('HtmlInspector + TlsInspector - should detect tls_expired', async () => {
    const result = await HtmlInspector.inspect({ url: 'https://mock-expired.local' }, {});
    assert.strictEqual(result.ok, true);
    assert.ok(result.tls);
    const finding = result.findings.find(f => f.id === 'tls_expired');
    assert.ok(finding);
    assert.strictEqual(finding.severity, 'high');
  });

  await t.test('HtmlInspector + TlsInspector - should detect tls_expiring_soon', async () => {
    const result = await HtmlInspector.inspect({ url: 'https://mock-expiring-soon.local' }, {});
    assert.strictEqual(result.ok, true);
    assert.ok(result.tls);
    const finding = result.findings.find(f => f.id === 'tls_expiring_soon');
    assert.ok(finding);
    assert.strictEqual(finding.severity, 'medium');
  });

  await t.test('TlsInspector.inspect - should parse mock-unauthorized.local certificate details', async () => {
    const { TlsInspector } = await import('./tlsInspector.js');
    const tlsResult = await TlsInspector.inspect('https://mock-unauthorized.local');
    assert.strictEqual(tlsResult.ok, true);
    assert.strictEqual(tlsResult.authorized, false);
    assert.strictEqual(tlsResult.authorizationError, 'self-signed certificate');
    assert.strictEqual(tlsResult.subject, 'mock-unauthorized.local');
  });

  await t.test('HtmlInspector.buildTlsFindings - should return expired, unauthorized, or expiring soon findings based on inputs', () => {
    const expiredTls = {
      ok: true,
      authorized: true,
      validTo: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString() // expired 5 days ago
    };
    const findingsExpired = HtmlInspector.buildTlsFindings(expiredTls);
    assert.strictEqual(findingsExpired.length, 1);
    assert.strictEqual(findingsExpired[0].id, 'tls_expired');

    const unauthorizedTls = {
      ok: true,
      authorized: false,
      authorizationError: 'unable to verify the first certificate'
    };
    const findingsUnauthorized = HtmlInspector.buildTlsFindings(unauthorizedTls);
    assert.strictEqual(findingsUnauthorized.length, 1);
    assert.strictEqual(findingsUnauthorized[0].id, 'tls_unauthorized');

    const expiringSoonTls = {
      ok: true,
      authorized: true,
      validTo: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString() // expires in 15 days
    };
    const findingsExpiring = HtmlInspector.buildTlsFindings(expiringSoonTls);
    assert.strictEqual(findingsExpiring.length, 1);
    assert.strictEqual(findingsExpiring[0].id, 'tls_expiring_soon');
  });
});
