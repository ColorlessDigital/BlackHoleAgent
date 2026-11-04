import * as cheerio from 'cheerio';
import { HttpInspector } from './httpInspector.js';
import { TlsInspector } from './tlsInspector.js';
import { URL } from 'url';

export class HtmlInspector {
  static async inspect(params = {}, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const fetchRes = await HttpInspector.fetch(params, config, options);
    options.abortSignal?.throwIfAborted();
    if (!fetchRes.ok) {
      return fetchRes;
    }

    const { url, finalUrl, http, body } = fetchRes;
    
    let tls = null;
    if (finalUrl.startsWith('https:')) {
      try {
        tls = await TlsInspector.inspect(finalUrl, config.webRequestTimeoutMs || 10000, options);
      } catch (err) {
        options.abortSignal?.throwIfAborted();
        tls = { ok: false, error: err.message };
      }
    }
    options.abortSignal?.throwIfAborted();
    const $ = cheerio.load(body);

    const title = $('title').text().trim() || 'No Title';
    
    const meta = [];
    $('meta').each((_, el) => {
      const name = $(el).attr('name') || $(el).attr('property') || $(el).attr('http-equiv');
      const content = $(el).attr('content');
      if (name || content) {
        meta.push({ name: name || '', content: content || '' });
      }
    });

    const forms = [];
    $('form').each((_, el) => {
      const action = $(el).attr('action') || '';
      const method = ($(el).attr('method') || 'GET').toUpperCase();
      const inputs = [];
      $(el).find('input, select, textarea').each((_, inputEl) => {
        inputs.push({
          type: $(inputEl).attr('type') || 'text',
          name: $(inputEl).attr('name') || '',
          id: $(inputEl).attr('id') || ''
        });
      });
      forms.push({ action, method, inputs });
    });

    const scripts = [];
    $('script').each((_, el) => {
      const src = $(el).attr('src') || '';
      const type = $(el).attr('type') || '';
      const content = $(el).html() || '';
      scripts.push({
        src,
        type,
        isInline: !src,
        charLength: content.length
      });
    });

    const iframes = [];
    $('iframe').each((_, el) => {
      iframes.push({
        src: $(el).attr('src') || '',
        name: $(el).attr('name') || '',
        id: $(el).attr('id') || ''
      });
    });

    const links = [];
    const externalDomains = new Set();
    const currentOrigin = new URL(finalUrl).origin;

    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          const resolved = new URL(href, finalUrl).toString();
          links.push(resolved);

          const parsedLink = new URL(resolved);
          if (parsedLink.origin !== currentOrigin) {
            externalDomains.add(parsedLink.hostname);
          }
        } catch {
          links.push(href);
        }
      }
    });

    const cookies = [];
    const setCookieHeaders = http.headers['set-cookie'] || [];
    const cookieArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    cookieArray.filter(Boolean).forEach(c => {
      const parts = c.split(';').map(p => p.trim());
      const [nameVal] = parts;
      const [name, val] = nameVal.split('=');
      cookies.push({
        name,
        value: val,
        secure: parts.some(p => p.toLowerCase() === 'secure'),
        httpOnly: parts.some(p => p.toLowerCase() === 'httponly'),
        sameSite: parts.find(p => p.toLowerCase().startsWith('samesite='))?.split('=')[1] || ''
      });
    });

    const secHeaders = {
      contentSecurityPolicy: !!(http.headers['content-security-policy'] || http.headers['x-webkit-csp'] || http.headers['x-content-security-policy']),
      strictTransportSecurity: !!http.headers['strict-transport-security'],
      xFrameOptions: !!http.headers['x-frame-options'],
      xContentTypeOptions: !!http.headers['x-content-type-options'],
      referrerPolicy: !!http.headers['referrer-policy'],
      permissionsPolicy: !!(http.headers['permissions-policy'] || http.headers['feature-policy'])
    };

    const findings = [];

    if (!secHeaders.contentSecurityPolicy) {
      findings.push({
        id: 'missing_csp',
        severity: 'medium',
        title: 'Content Security Policy (CSP) Header Missing',
        evidence: 'Response headers do not include a Content-Security-Policy definition.',
        recommendation: 'Implement CSP to restrict sources of script execution and mitigate Cross-Site Scripting (XSS).'
      });
    }

    if (finalUrl.startsWith('https:') && !secHeaders.strictTransportSecurity) {
      findings.push({
        id: 'missing_hsts',
        severity: 'medium',
        title: 'Strict-Transport-Security (HSTS) Header Missing',
        evidence: 'Response is served via HTTPS, but does not configure HSTS.',
        recommendation: 'Configure HSTS to enforce browser connections solely through secure TLS channels.'
      });
    }

    if (!secHeaders.xFrameOptions) {
      findings.push({
        id: 'missing_x_frame_options',
        severity: 'low',
        title: 'X-Frame-Options Header Missing',
        evidence: 'Response headers do not declare X-Frame-Options or frame-ancestors CSP directive.',
        recommendation: 'Add X-Frame-Options: DENY or SAMEORIGIN to protect against clickjacking attacks.'
      });
    }

    if (!secHeaders.xContentTypeOptions) {
      findings.push({
        id: 'missing_x_content_type_options',
        severity: 'low',
        title: 'X-Content-Type-Options Header Missing',
        evidence: 'Response headers lack x-content-type-options setting.',
        recommendation: 'Set X-Content-Type-Options: nosniff to prevent browsers from MIME-sniffing files.'
      });
    }

    if (finalUrl.startsWith('http:')) {
      findings.push({
        id: 'insecure_transport',
        severity: 'high',
        title: 'Insecure Plaintext Transport (HTTP)',
        evidence: `Target target page is hosted over plaintext channel: ${finalUrl}`,
        recommendation: 'Migrate the web application to HTTPS with valid TLS certificates to prevent interception.'
      });
    } else {
      forms.forEach(form => {
        try {
          const actionUrl = new URL(form.action, finalUrl);
          if (actionUrl.protocol === 'http:') {
            findings.push({
              id: 'insecure_form_action',
              severity: 'high',
              title: 'Insecure Form Action Target (HTTP)',
              evidence: `Form targets insecure action: ${form.action}`,
              recommendation: 'Update form action targets to secure HTTPS addresses.'
            });
          }
        } catch {}
      });
    }

    cookies.forEach(cookie => {
      const isSession = /session|sess|token|sid|auth/i.test(cookie.name);
      if (isSession) {
        if (!cookie.httpOnly) {
          findings.push({
            id: 'cookie_missing_httponly',
            severity: 'medium',
            title: `Session Cookie '${cookie.name}' Lacks HttpOnly`,
            evidence: `Cookie '${cookie.name}' is set without HttpOnly flag.`,
            recommendation: 'Configure HttpOnly flag for all sensitive cookies to shield them from XSS theft.'
          });
        }
        if (finalUrl.startsWith('https:') && !cookie.secure) {
          findings.push({
            id: 'cookie_missing_secure',
            severity: 'medium',
            title: `Session Cookie '${cookie.name}' Lacks Secure Flag`,
            evidence: `Cookie '${cookie.name}' is set without Secure attribute over HTTPS.`,
            recommendation: 'Enforce Secure attribute on session cookies to prevent transport over unencrypted HTTP.'
          });
        }
      }
    });

    if (tls) {
      findings.push(...HtmlInspector.buildTlsFindings(tls));
    }

    return {
      ok: true,
      url,
      finalUrl,
      timestamp: fetchRes.timestamp,
      http,
      html: {
        title,
        meta,
        forms,
        scripts,
        iframes,
        links,
        externalDomains: Array.from(externalDomains)
      },
      cookies,
      securityHeaders: secHeaders,
      tls,
      findings
    };
  }

  static buildTlsFindings(tls) {
    const findings = [];
    if (tls && tls.ok) {
      if (!tls.authorized) {
        findings.push({
          id: 'tls_unauthorized',
          severity: 'high',
          title: 'TLS Certificate Verification Failed (Unauthorized)',
          evidence: `TLS verification error: ${tls.authorizationError || 'self-signed or untrusted certificate'}`,
          recommendation: 'Check the certificate validity, root authority trust chain, and ensure it matches the target hostname.'
        });
      }

      if (tls.validTo) {
        const expireDate = new Date(tls.validTo);
        const now = new Date();
        if (expireDate < now) {
          findings.push({
            id: 'tls_expired',
            severity: 'high',
            title: 'TLS Certificate Expired',
            evidence: `The TLS certificate expired on ${tls.validTo}.`,
            recommendation: 'Renew the SSL/TLS certificate immediately.'
          });
        } else if (expireDate - now < 30 * 24 * 60 * 60 * 1000) {
          const daysRemaining = Math.ceil((expireDate - now) / (24 * 60 * 60 * 1000));
          findings.push({
            id: 'tls_expiring_soon',
            severity: 'medium',
            title: 'TLS Certificate Expiring Soon',
            evidence: `The TLS certificate will expire in ${daysRemaining} days (on ${tls.validTo}).`,
            recommendation: 'Schedule a renewal of the SSL/TLS certificate prior to expiration.'
          });
        }
      }
    }
    return findings;
  }
}
