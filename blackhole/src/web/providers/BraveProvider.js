import { withWebRequest } from '../requestScope.js';

export class BraveProvider {
  static async search(query, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const apiKey = config.braveApiKey;
    if (!apiKey) {
      return { ok: false, provider: 'brave', error: 'Brave API Key가 설정되어 있지 않습니다.' };
    }

    return withWebRequest(config, options, async signal => {
      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': apiKey
          },
          signal
        });

        if (!response.ok) {
          throw new Error(`API 응답 오류 (Status: ${response.status})`);
        }

        const data = await response.json();
        const results = (data.web?.results || []).map(r => ({
          title: r.title || 'No Title',
          url: r.url || '',
          snippet: r.description || '',
          score: 1.0
        }));

        return {
          ok: true,
          provider: 'brave',
          timestamp: new Date().toISOString(),
          results
        };
      } catch (err) {
        return { ok: false, provider: 'brave', error: `Brave API 호출 실패: ${err.message}` };
      }
    });
  }
}
