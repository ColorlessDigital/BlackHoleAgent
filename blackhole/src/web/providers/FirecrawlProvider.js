import { withWebRequest } from '../requestScope.js';

export class FirecrawlProvider {
  static async search(query, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const apiKey = config.firecrawlApiKey;
    if (!apiKey) {
      return { ok: false, provider: 'firecrawl', error: 'Firecrawl API Key가 설정되어 있지 않습니다.' };
    }

    return withWebRequest(config, options, async signal => {
      try {
        const response = await fetch('https://api.firecrawl.dev/v1/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            query,
            limit: 5
          }),
          signal
        });

        if (!response.ok) {
          throw new Error(`API 응답 오류 (Status: ${response.status})`);
        }

        const data = await response.json();
        const results = (data.data || []).map(r => ({
          title: r.title || r.metadata?.title || 'No Title',
          url: r.url || r.metadata?.sourceURL || '',
          snippet: r.description || r.markdown || r.content || r.metadata?.description || '',
          score: 1.0
        }));

        return {
          ok: true,
          provider: 'firecrawl',
          timestamp: new Date().toISOString(),
          results
        };
      } catch (err) {
        return { ok: false, provider: 'firecrawl', error: `Firecrawl API 호출 실패: ${err.message}` };
      }
    });
  }
}
