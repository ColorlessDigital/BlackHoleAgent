import { isUrlAllowed } from './urlPolicy.js';
import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../config/configStore.js';

export class RenderInspector {
  static async render(params = {}, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const { url } = params;
    if (!url) {
      return { ok: false, error: 'URL이 지정되지 않았습니다.' };
    }

    if (!isUrlAllowed(url, config)) {
      return { ok: false, error: `허가되지 않은 도메인 대상 웹 요청입니다. Allowed scope: ${config.webAllowedDomains || '(All)'}` };
    }

    if (!config.webRenderEnabled) {
      return { ok: false, error: '렌더링 분석(render_page) 기능이 비활성화 상태입니다. 설정에서 사용 가능하도록 체크해 주세요.' };
    }

    let playwright;
    try {
      playwright = await import('playwright');
    } catch {
      return { ok: false, error: 'Playwright 모듈이 시스템에 존재하지 않습니다. 이 기능을 사용하려면 npm install playwright를 통해 라이브러리를 먼저 구축해 주세요.' };
    }

    const timeout = Number(config.webRequestTimeoutMs) || 15000;
    const renderArtifactsDir = path.join(CONFIG_DIR, 'web_evidence', 'render_artifacts');
    if (!fs.existsSync(renderArtifactsDir)) {
      fs.mkdirSync(renderArtifactsDir, { recursive: true });
    }

    let browser = null;
    const onAbort = () => { browser?.close().catch(() => {}); };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout });
      options.abortSignal?.throwIfAborted();

      const contextOptions = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      let harPath = null;
      if (params.har || params.harPath) {
        harPath = params.harPath || path.join(renderArtifactsDir, `har_${Date.now()}.har`);
        contextOptions.recordHar = { path: harPath };
      }

      const context = await browser.newContext(contextOptions);
      context.setDefaultTimeout(timeout);
      const page = await context.newPage();

      const consoleErrors = [];
      const failedRequests = [];
      const networkRequests = [];

      page.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      page.on('requestfailed', req => {
        failedRequests.push({
          url: req.url(),
          failureText: req.failure()?.errorText || 'unknown error'
        });
      });

      page.on('request', req => {
        networkRequests.push({
          url: req.url(),
          method: req.method()
        });
      });

      await page.goto(url, { waitUntil: 'load', timeout });
      const finalUrl = page.url();
      const content = await page.content();
      const title = await page.title();

      let screenshotPath = null;
      if (params.screenshot || params.screenshotPath) {
        screenshotPath = params.screenshotPath || path.join(renderArtifactsDir, `screenshot_${Date.now()}.png`);
        const parentDir = path.dirname(screenshotPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }

      options.abortSignal?.throwIfAborted();

      return {
        ok: true,
        url,
        finalUrl,
        timestamp: new Date().toISOString(),
        title,
        consoleErrors,
        failedRequests,
        networkRequests: networkRequests.slice(0, 30),
        htmlLength: content.length,
        contentPreview: content.slice(0, 2000),
        ...(screenshotPath ? { screenshotPath } : {}),
        ...(harPath ? { harPath } : {})
      };
    } catch (err) {
      options.abortSignal?.throwIfAborted();
      return { ok: false, error: `브라우저 렌더링 중 오류 발생: ${err.message}` };
    } finally {
      options.abortSignal?.removeEventListener('abort', onAbort);
      if (browser) {
        try {
          await browser.close();
        } catch {}
      }
    }
  }
}
