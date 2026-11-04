import { withWebRequest } from '../requestScope.js';

export class ExaProvider {
  static async search(query, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const apiKey = config.exaApiKey;
    if (!apiKey) {
      return { ok: false, provider: 'exa', error: 'Exa API Key가 설정되어 있지 않습니다.' };
    }

    return withWebRequest(config, options, async signal => {
      try {
        const response = await fetch('https://api.exa.ai/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
          },
          body: JSON.stringify({
            query,
            numResults: 5,
            highlights: {
              numSentences: 3
            }
          }),
          signal
        });

        if (!response.ok) {
          throw new Error(`API 응답 오류 (Status: ${response.status})`);
        }

        const data = await response.json();
        const results = (data.results || []).map(r => {
          let snippet = '';
          if (r.highlights && r.highlights.length > 0) {
            snippet = r.highlights.join(' ... ');
          } else if (r.text) {
            snippet = r.text.slice(0, 300);
          }
          return {
            title: r.title || 'No Title',
            url: r.url || '',
            snippet: snippet,
            score: r.score || 1.0
          };
        });

        return {
          ok: true,
          provider: 'exa',
          timestamp: new Date().toISOString(),
          results
        };
      } catch (err) {
        return { ok: false, provider: 'exa', error: `Exa API 호출 실패: ${err.message}` };
      }
    });
  }
}
