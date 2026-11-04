import { withWebRequest } from '../requestScope.js';

export class TavilyProvider {
  static async search(query, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const apiKey = config.tavilyApiKey;
    if (!apiKey) {
      return { ok: false, provider: 'tavily', error: 'Tavily API Key가 설정되어 있지 않습니다.' };
    }

    return withWebRequest(config, options, async signal => {
      try {
        const response = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: 'basic'
          }),
          signal
        });

        if (!response.ok) {
          throw new Error(`API 응답 오류 (Status: ${response.status})`);
        }

        const data = await response.json();
        const results = (data.results || []).map(r => ({
          title: r.title || 'No Title',
          url: r.url || '',
          snippet: r.content || '',
          score: r.score || 1.0
        }));

        return {
          ok: true,
          provider: 'tavily',
          timestamp: new Date().toISOString(),
          results
        };
      } catch (err) {
        return { ok: false, provider: 'tavily', error: `Tavily API 호출 실패: ${err.message}` };
      }
    });
  }
}
