import { DuckDuckGoProvider } from './providers/DuckDuckGoProvider.js';
import { TavilyProvider } from './providers/TavilyProvider.js';
import { ExaProvider } from './providers/ExaProvider.js';
import { BraveProvider } from './providers/BraveProvider.js';
import { FirecrawlProvider } from './providers/FirecrawlProvider.js';

const PROVIDER_MAP = {
  duckduckgo: DuckDuckGoProvider,
  tavily: TavilyProvider,
  exa: ExaProvider,
  brave: BraveProvider,
  firecrawl: FirecrawlProvider
};

export class SearchService {
  /**
   * 검색 요청을 적절한 Provider에 라우팅하고, 실패 시 DuckDuckGo로 Fallback합니다.
   * @param {object} params - { query, provider? }
   * @param {object} config - configStore에서 로드된 설정 객체
   * @returns {Promise<object>} 검색 결과 JSON
   */
  static async search(params = {}, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const { query, provider: requestedProvider } = params;

    if (!query || !query.trim()) {
      return { ok: false, error: '검색어가 비어 있습니다.' };
    }

    const providerName = (requestedProvider || config.webSearchProvider || 'duckduckgo').toLowerCase();
    const ProviderClass = PROVIDER_MAP[providerName];

    if (!ProviderClass) {
      return { ok: false, error: `지원하지 않는 검색 프로바이더입니다: ${providerName}` };
    }

    // Determine maxResults configuration
    const maxResults = Number(params.maxResults || config.webSearchMaxResults || 5);
    const providerConfig = {
      ...config,
      maxResults
    };

    const needsKey = providerName !== 'duckduckgo';
    const keyMap = {
      tavily: config.tavilyApiKey,
      exa: config.exaApiKey,
      brave: config.braveApiKey,
      firecrawl: config.firecrawlApiKey
    };

    let result;
    let fallbackOccurred = false;
    let fallbackReason = null;

    if (needsKey && !keyMap[providerName]) {
      fallbackOccurred = true;
      fallbackReason = `${providerName} API Key 미설정으로 DuckDuckGo fallback 실행`;
      result = await DuckDuckGoProvider.search(query, providerConfig, options);
    } else {
      try {
        result = await ProviderClass.search(query, providerConfig, options);
        options.abortSignal?.throwIfAborted();
        if (!result.ok && providerName !== 'duckduckgo') {
          fallbackOccurred = true;
          fallbackReason = `${providerName} 실패 (${result.error}), DuckDuckGo fallback 실행`;
          result = await DuckDuckGoProvider.search(query, providerConfig, options);
        }
      } catch (err) {
        options.abortSignal?.throwIfAborted();
        if (providerName !== 'duckduckgo') {
          fallbackOccurred = true;
          fallbackReason = `${providerName} 예외 발생 (${err.message}), DuckDuckGo fallback 실행`;
          result = await DuckDuckGoProvider.search(query, providerConfig, options);
        } else {
          result = { ok: false, error: err.message };
        }
      }
    }

    options.abortSignal?.throwIfAborted();
    if (!result.ok) {
      return {
        ok: false,
        provider: result.provider || providerName,
        query,
        timestamp: new Date().toISOString(),
        results: [],
        error: result.error,
        status: result.status || 'failed',
        fallback: fallbackOccurred,
        _fallback: fallbackOccurred,
        _fallbackReason: fallbackReason
      };
    }

    // Deduplicate results by URL
    const seenUrls = new Set();
    const rawResults = result.results || [];
    const dedupedResults = [];
    for (const r of rawResults) {
      if (!r.url) continue;
      const normalizedUrl = r.url.trim().replace(/\/$/, '');
      if (!seenUrls.has(normalizedUrl)) {
        seenUrls.add(normalizedUrl);
        dedupedResults.push(r);
      }
    }

    // Final slice to maxResults
    const slicedResults = dedupedResults.slice(0, maxResults);

    return {
      ok: true,
      provider: result.provider || providerName,
      query,
      timestamp: result.timestamp || new Date().toISOString(),
      results: slicedResults,
      fallback: fallbackOccurred,
      _fallback: fallbackOccurred,
      _fallbackReason: fallbackReason,
      warning: result.warning || null,
      degraded: !!result.degraded,
      status: result.status || 'success'
    };
  }
}
