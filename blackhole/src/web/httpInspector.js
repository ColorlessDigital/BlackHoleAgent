import { isUrlAllowed } from './urlPolicy.js';
import crypto from 'crypto';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../config/configStore.js';
import * as cheerio from 'cheerio';
import { withWebRequest } from './requestScope.js';

const EVIDENCE_DIR = path.join(CONFIG_DIR, 'web_evidence');
const BODIES_DIR = path.join(EVIDENCE_DIR, 'bodies');

export class HttpInspector {
  static async fetch(params = {}, config = {}, options = {}) {
    return withWebRequest(config, options, signal => this.fetchResponse(params, config, signal));
  }

  static async fetchResponse(params, config, signal) {
    const { url } = params;
    if (!url) {
      return { ok: false, error: 'URL이 지정되지 않았습니다.' };
    }

    if (!isUrlAllowed(url, config)) {
      return { ok: false, error: `허가되지 않은 도메인 대상 웹 요청입니다. Allowed scope: ${config.webAllowedDomains || '(All)'}` };
    }

    const maxBytes = Number(config.webMaxResponseBytes) || 1048576;
    const redirectLimit = 5;

    let currentUrl = url;
    const redirects = [];
    let response = null;
    let redirectCount = 0;

    while (redirectCount <= redirectLimit) {
      signal.throwIfAborted();

      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
          },
          redirect: 'manual',
          signal
        });
      } catch (err) {
        return { ok: false, error: `HTTP 요청 실패: ${err.message}` };
      }

      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          break;
        }
        await response.body?.cancel();

        const resolvedUrl = new URL(location, currentUrl).toString();
        redirects.push({ status, from: currentUrl, to: resolvedUrl });

        if (!isUrlAllowed(resolvedUrl, config)) {
          return { ok: false, error: `Redirect된 도메인이 허가 범위에 속하지 않습니다: ${resolvedUrl}` };
        }

        currentUrl = resolvedUrl;
        redirectCount++;
      } else {
        break;
      }
    }

    if (redirectCount > redirectLimit) {
      return { ok: false, error: '최대 Redirect 한도를 초과했습니다.' };
    }

    const contentType = response.headers.get('content-type') || 'text/html';
    const isTextLike = /^(text\/(html|plain|xml)|application\/(json|xml|\+xml))/i.test(contentType);

    let bodyText = '';
    let bytesRead = 0;
    let truncated = false;
    let bodyBuffer = null;

    if (response.body) {
      const reader = response.body.getReader();
      const chunks = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value) {
            if (bytesRead + value.byteLength > maxBytes) {
              const remaining = maxBytes - bytesRead;
              if (remaining > 0) {
                chunks.push(value.slice(0, remaining));
                bytesRead += remaining;
              }
              truncated = true;
              await reader.cancel();
              break;
            } else {
              chunks.push(value);
              bytesRead += value.byteLength;
            }
          }
        }

        bodyBuffer = new Uint8Array(bytesRead);
        let offset = 0;
        for (const chunk of chunks) {
          bodyBuffer.set(chunk, offset);
          offset += chunk.length;
        }

        if (isTextLike) {
          bodyText = new TextDecoder('utf-8').decode(bodyBuffer);
          if (truncated) {
            bodyText += '\n\n...[Warning: Response body truncated due to max bytes limit]';
          }
        } else {
          bodyText = '[Body preview omitted for non-text content-type]';
        }
      } catch (err) {
        return { ok: false, error: `응답 스트리밍 읽기 실패: ${err.message}` };
      } finally {
        reader.releaseLock();
      }
    } else {
      bodyBuffer = new Uint8Array(0);
      bodyText = '';
    }

    signal.throwIfAborted();
    const bodyHash = crypto.createHash('sha256').update(bodyBuffer).digest('hex');
    const headers = {};
    response.headers.forEach((val, key) => {
      headers[key] = val;
    });
    if (typeof response.headers.getSetCookie === 'function') {
      const setCookies = response.headers.getSetCookie();
      if (setCookies && setCookies.length > 0) {
        headers['set-cookie'] = setCookies;
      }
    }

    // Save full body to disk
    if (!fs.existsSync(BODIES_DIR)) {
      fs.mkdirSync(BODIES_DIR, { recursive: true });
    }
    const bodyPath = path.join(BODIES_DIR, `${bodyHash}.txt`);
    try {
      fs.writeFileSync(bodyPath, bodyText, 'utf-8');
    } catch (err) {
      console.error('Failed to write response body to disk:', err);
    }

    // Limit body preview to 2000 chars
    const bodyPreview = bodyText.substring(0, 2000);
    let textPreview = bodyText.slice(0, 12000);
    if (/html/i.test(contentType)) {
      const $ = cheerio.load(bodyText);
      $('script,style,noscript,nav,header,footer').remove();
      const main = $('main,article,[role="main"],#contents,#content').first();
      const content = main.length ? main : $('body');
      content.find('br').replaceWith('\n');
      content.find('p,div,li,h1,h2,h3,tr,section').append('\n');
      textPreview = content.text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n/g, '\n').trim().slice(0, 12000);
    }

    return {
      ok: true,
      url,
      finalUrl: currentUrl,
      timestamp: new Date().toISOString(),
      truncated,
      bytesRead,
      maxBytes,
      http: {
        status: response.status,
        headers,
        redirects,
        contentType,
        bodyHash,
        bodyHashIsFull: !truncated
      },
      body: bodyPreview,
      textPreview,
      bodyPath
    };
  }
}
