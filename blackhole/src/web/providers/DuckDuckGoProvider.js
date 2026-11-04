import https from 'https';
import { withWebRequest } from '../requestScope.js';

export class DuckDuckGoProvider {
  static search(query, config = {}, requestOptions = {}) {
    return withWebRequest(config, requestOptions, signal => new Promise((resolve) => {
      const encQuery = encodeURIComponent(query);
      const options = {
        hostname: 'html.duckduckgo.com',
        port: 443,
        path: `/html/?q=${encQuery}`,
        method: 'GET',
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      };

      const req = https.get(options, (res) => {
        let data = '';
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > (Number(config.webMaxResponseBytes) || 1048576)) {
            req.destroy(new Error('Search response exceeded the configured byte limit.'));
            return;
          }
          data += chunk;
        });
        res.on('error', error => resolve({ ok: false, provider: 'duckduckgo', error: error.message }));
        res.on('end', () => {
          try {
            const results = [];
            const matches = data.match(/<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<div class="clear">/g);
            
            if (!matches || matches.length === 0) {
              const isBlocked = data.includes('Forbidden') || data.includes('robot') || data.includes('captcha') || data.includes('ddg-lms') || data.includes('Access Denied');
              if (isBlocked) {
                resolve({
                  ok: false,
                  provider: 'duckduckgo',
                  error: 'DuckDuckGo에 의해 요청이 거부되었거나 Captcha가 활성화되었습니다.',
                  status: 'blocked'
                });
              } else if (!data || data.trim().length < 500) {
                resolve({
                  ok: true,
                  provider: 'duckduckgo',
                  results: [],
                  warning: '검색 결과가 없거나 응답이 비어있습니다.',
                  status: 'empty'
                });
              } else {
                resolve({
                  ok: true,
                  provider: 'duckduckgo',
                  results: [],
                  warning: 'DuckDuckGo HTML 구조 파싱 실패로 결과를 추출하지 못했습니다.',
                  degraded: true,
                  status: 'degraded'
                });
              }
              return;
            }

            const maxResults = config.maxResults || 5;
            for (const m of matches.slice(0, maxResults)) {
              const urlMatch = m.match(/href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"/i) ||
                               m.match(/class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/i) ||
                               m.match(/href="([^"]+)"[^>]*class="[^"]*result__snippet[^"]*"/i) ||
                               m.match(/class="[^"]*result__snippet[^"]*"[^>]*href="([^"]+)"/i);

              const titleMatch = m.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
                                 m.match(/<a[^>]*class="[^"]*result__url[^"]*"[^>]*>([\s\S]*?)<\/a>/i);

              const snippetMatch = m.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
                                   m.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

              if (urlMatch && titleMatch) {
                let url = urlMatch[1];
                if (url && url.includes('uddg=')) {
                  const uddg = url.split('uddg=')[1].split('&')[0];
                  url = decodeURIComponent(uddg);
                }
                const title = titleMatch[1] ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'No Title';
                const snippet = snippetMatch && snippetMatch[1] ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                results.push({
                  title,
                  url,
                  snippet,
                  score: 1.0
                });
              }
            }

            resolve({
              ok: true,
              provider: 'duckduckgo',
              timestamp: new Date().toISOString(),
              results
            });
          } catch (e) {
            resolve({ ok: false, provider: 'duckduckgo', error: `DuckDuckGo 파싱 에러: ${e.message}` });
          }
        });
      });

      req.on('error', (e) => {
        resolve({ ok: false, provider: 'duckduckgo', error: `DuckDuckGo 연결 실패: ${e.message}` });
      });
      req.end();
    }));
  }
}
