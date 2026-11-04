import https from 'https';
import { URL } from 'url';
import { withWebRequest } from './requestScope.js';

export class TlsInspector {
  static async inspect(urlStr, timeoutMs = 5000, requestOptions = {}) {
    return withWebRequest({ webRequestTimeoutMs: timeoutMs }, requestOptions, signal => new Promise((resolve) => {
      try {
        const parsedUrl = new URL(urlStr);
        if (parsedUrl.protocol !== 'https:') {
          return resolve(null);
        }

        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: '/',
          method: 'GET',
          signal,
          rejectUnauthorized: false, // Don't reject so we can examine unauthorized certs
          agent: false
        };

        let resolved = false;
        const req = https.request(options, (res) => {
          const socket = res.socket;
          const cert = socket.getPeerCertificate(true);
          const cipher = socket.getCipher();
          const protocol = socket.getProtocol();

          if (!resolved) {
            resolved = true;
            if (!cert || Object.keys(cert).length === 0) {
              resolve({
                ok: false,
                error: '인증서 정보를 수집할 수 없습니다.'
              });
            } else {
              resolve({
                ok: true,
                protocol,
                cipher: cipher ? `${cipher.name} (${cipher.version})` : null,
                authorized: socket.authorized,
                authorizationError: socket.authorizationError || null,
                subject: cert.subject ? (cert.subject.CN || JSON.stringify(cert.subject)) : 'Unknown',
                issuer: cert.issuer ? (cert.issuer.CN || JSON.stringify(cert.issuer)) : 'Unknown',
                validFrom: cert.valid_from ? new Date(cert.valid_from).toISOString() : null,
                validTo: cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
                fingerprint256: cert.fingerprint256 || null
              });
            }
          }
          if (res.destroy) res.destroy();
          else res.resume();
        });

        req.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            resolve({ ok: false, error: `TLS 연결 실패: ${err.message}` });
          }
        });

        req.setTimeout(timeoutMs, () => {
          req.destroy();
          if (!resolved) {
            resolved = true;
            resolve({ ok: false, error: 'TLS 연결 타임아웃' });
          }
        });

        req.end();
      } catch (err) {
        resolve({ ok: false, error: `TLS 분석 실패: ${err.message}` });
      }
    }));
  }
}
