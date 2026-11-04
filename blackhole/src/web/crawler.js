import { isUrlAllowed } from './urlPolicy.js';
import { HtmlInspector } from './htmlInspector.js';
import { URL } from 'url';
import { setTimeout as wait } from 'node:timers/promises';

export class Crawler {
  static async crawl(params = {}, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const { url } = params;
    const maxDepth = Number(params.depth !== undefined ? params.depth : (config.webCrawlerMaxDepth !== undefined ? config.webCrawlerMaxDepth : 1));
    const limit = Number(params.limit !== undefined ? params.limit : (config.webCrawlerMaxPages !== undefined ? config.webCrawlerMaxPages : 20));
    const delay = Number(config.webCrawlerDelayMs) || 1000;

    if (!url) {
      return { ok: false, error: '시작 URL이 지정되지 않았습니다.' };
    }

    if (!isUrlAllowed(url, config)) {
      return { ok: false, error: `허가되지 않은 도메인 대상 웹 요청입니다. Allowed scope: ${config.webAllowedDomains || '(All)'}` };
    }

    let startOrigin;
    try {
      startOrigin = new URL(url).origin;
    } catch {
      return { ok: false, error: '유효하지 않은 시작 URL 형식입니다.' };
    }

    const visited = new Set();
    const queue = [{ url, depth: 0 }];
    const results = [];

    while (queue.length > 0 && results.length < limit) {
      options.abortSignal?.throwIfAborted();
      const current = queue.shift();
      
      if (visited.has(current.url) || current.depth > maxDepth) {
        continue;
      }

      visited.add(current.url);

      try {
        const currParsed = new URL(current.url);
        if (currParsed.origin !== startOrigin) {
          continue;
        }
      } catch {
        continue;
      }

      if (!isUrlAllowed(current.url, config)) {
        continue;
      }

      if (results.length > 0 && delay > 0) {
        try { await wait(delay, undefined, { signal: options.abortSignal }); }
        catch (error) { options.abortSignal?.throwIfAborted(); throw error; }
      }

      const inspectRes = await HtmlInspector.inspect({ url: current.url }, config, options);
      options.abortSignal?.throwIfAborted();
      if (!inspectRes.ok) {
        results.push({
          url: current.url,
          status: 'failed',
          error: inspectRes.error
        });
        continue;
      }

      results.push({
        url: current.url,
        status: 'success',
        title: inspectRes.html.title,
        findingsCount: inspectRes.findings?.length || 0,
        findings: inspectRes.findings || []
      });

      if (current.depth < maxDepth) {
        const links = inspectRes.html.links || [];
        for (const link of links) {
          try {
            const parsedLink = new URL(link);
            const normalizedLink = parsedLink.origin + parsedLink.pathname + parsedLink.search;
            if (parsedLink.origin === startOrigin && !visited.has(normalizedLink) && !queue.some(q => q.url === normalizedLink)) {
              queue.push({ url: normalizedLink, depth: current.depth + 1 });
            }
          } catch {}
        }
      }
    }

    return {
      ok: true,
      startUrl: url,
      maxDepth,
      pageLimit: limit,
      pagesCrawled: results.length,
      timestamp: new Date().toISOString(),
      results
    };
  }
}
