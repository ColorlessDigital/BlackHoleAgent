import { HtmlInspector } from './htmlInspector.js';
import { FileEvidenceRepository } from './evidenceRepository.js';

export class EvidenceStore {
  static getPreviousRecord(url) {
    return FileEvidenceRepository.getPreviousRecord(url);
  }

  static appendRecord(record, retentionLimit = 20) {
    FileEvidenceRepository.appendRecord(record.url, record, retentionLimit);
  }

  static async monitor(params = {}, config = {}, options = {}) {
    options.abortSignal?.throwIfAborted();
    const { url } = params;
    if (!url) {
      return { ok: false, error: '모니터링 대상 URL이 입력되지 않았습니다.' };
    }

    const currentInspect = await HtmlInspector.inspect({ url }, config, options);
    options.abortSignal?.throwIfAborted();
    if (!currentInspect.ok) {
      return currentInspect;
    }

    const prev = this.getPreviousRecord(url);

    const diffs = {
      changed: false,
      statusChanged: false,
      bodyHashChanged: false,
      findingsChanged: false,
      headersChanged: false,
      domainsChanged: false,
      scriptsChanged: false,
      redirectsChanged: false,
      details: []
    };

    if (prev) {
      // 1. Status Check
      if (prev.http?.status !== currentInspect.http?.status) {
        diffs.changed = true;
        diffs.statusChanged = true;
        diffs.details.push(`HTTP 응답 코드가 변경되었습니다: ${prev.http?.status} -> ${currentInspect.http?.status}`);
      }

      // 2. Body Hash Check
      if (prev.http?.bodyHash !== currentInspect.http?.bodyHash) {
        diffs.changed = true;
        diffs.bodyHashChanged = true;
        diffs.details.push('HTML 본문 해시값이 변경되었습니다. 소스코드가 수정된 흔적이 감지되었습니다.');
      }

      // 3. Findings Check
      const prevFindingsIds = (prev.findings || []).map(f => f.id);
      const currFindingsIds = (currentInspect.findings || []).map(f => f.id);

      const addedFindings = currFindingsIds.filter(id => !prevFindingsIds.includes(id));
      const resolvedFindings = prevFindingsIds.filter(id => !currFindingsIds.includes(id));

      if (addedFindings.length > 0 || resolvedFindings.length > 0) {
        diffs.changed = true;
        diffs.findingsChanged = true;
        if (addedFindings.length > 0) {
          diffs.details.push(`새로운 보안 미흡점 감지: ${addedFindings.join(', ')}`);
        }
        if (resolvedFindings.length > 0) {
          diffs.details.push(`조치 완료된 보안 미흡점: ${resolvedFindings.join(', ')}`);
        }
      }

      // 4. Security Headers Check
      const prevSec = prev.securityHeaders || {};
      const currSec = currentInspect.securityHeaders || {};
      const secKeys = ['contentSecurityPolicy', 'strictTransportSecurity', 'xFrameOptions', 'xContentTypeOptions', 'referrerPolicy', 'permissionsPolicy'];
      let headerChanged = false;
      secKeys.forEach(k => {
        if (!!prevSec[k] !== !!currSec[k]) {
          headerChanged = true;
          diffs.details.push(`보안 헤더 설정 변경: ${k} (${!!prevSec[k]} -> ${!!currSec[k]})`);
        }
      });
      if (headerChanged) {
        diffs.changed = true;
        diffs.headersChanged = true;
      }

      // 5. External Domains Check
      const prevDomains = prev.html?.externalDomains || [];
      const currDomains = currentInspect.html?.externalDomains || [];
      const addedDomains = currDomains.filter(d => !prevDomains.includes(d));
      const removedDomains = prevDomains.filter(d => !currDomains.includes(d));
      if (addedDomains.length > 0 || removedDomains.length > 0) {
        diffs.changed = true;
        diffs.domainsChanged = true;
        if (addedDomains.length > 0) {
          diffs.details.push(`새로운 외부 도메인 링크 감지: ${addedDomains.join(', ')}`);
        }
        if (removedDomains.length > 0) {
          diffs.details.push(`외부 도메인 링크 제거: ${removedDomains.join(', ')}`);
        }
      }

      // 6. Scripts Check
      const prevScripts = prev.html?.scripts || [];
      const currScripts = currentInspect.html?.scripts || [];
      const prevSrcs = prevScripts.map(s => s.src).filter(Boolean);
      const currSrcs = currScripts.map(s => s.src).filter(Boolean);
      const addedSrcs = currSrcs.filter(src => !prevSrcs.includes(src));
      const removedSrcs = prevSrcs.filter(src => !currSrcs.includes(src));
      
      let scriptChanged = false;
      if (addedSrcs.length > 0 || removedSrcs.length > 0) {
        scriptChanged = true;
        if (addedSrcs.length > 0) {
          diffs.details.push(`새로운 외부 스크립트 로드: ${addedSrcs.join(', ')}`);
        }
        if (removedSrcs.length > 0) {
          diffs.details.push(`외부 스크립트 로드 중단: ${removedSrcs.join(', ')}`);
        }
      }
      
      const prevInlineLen = prevScripts.filter(s => s.isInline).reduce((acc, s) => acc + (s.charLength || 0), 0);
      const currInlineLen = currScripts.filter(s => s.isInline).reduce((acc, s) => acc + (s.charLength || 0), 0);
      if (prevInlineLen !== currInlineLen) {
        scriptChanged = true;
        diffs.details.push(`인라인 스크립트 총 글자 수 변경: ${prevInlineLen}자 -> ${currInlineLen}자`);
      }

      if (scriptChanged) {
        diffs.changed = true;
        diffs.scriptsChanged = true;
      }

      // 7. Redirects Check
      const prevRedirs = prev.http?.redirects || [];
      const currRedirs = currentInspect.http?.redirects || [];
      const prevDest = prevRedirs.length > 0 ? prevRedirs[prevRedirs.length - 1].to : null;
      const currDest = currRedirs.length > 0 ? currRedirs[currRedirs.length - 1].to : null;
      if (prevDest !== currDest) {
        diffs.changed = true;
        diffs.redirectsChanged = true;
        diffs.details.push(`리다이렉트 체인 목적지 변경: ${prevDest || '없음'} -> ${currDest || '없음'}`);
      }

    } else {
      diffs.details.push('최초 감시 등록 대상입니다. 이전 내역이 존재하지 않아 기준 기록으로 저장합니다.');
    }

    const snapshotId = `snap-${Date.now()}`;
    const storeRecord = {
      snapshotId,
      url,
      finalUrl: currentInspect.finalUrl,
      timestamp: currentInspect.timestamp,
      diffs: prev ? diffs : null,
      http: {
        status: currentInspect.http.status,
        bodyHash: currentInspect.http.bodyHash,
        contentType: currentInspect.http.contentType,
        headers: {
          'content-security-policy': currentInspect.http.headers?.['content-security-policy'] || '',
          'strict-transport-security': currentInspect.http.headers?.['strict-transport-security'] || '',
          'x-frame-options': currentInspect.http.headers?.['x-frame-options'] || '',
          'x-content-type-options': currentInspect.http.headers?.['x-content-type-options'] || '',
          'referrer-policy': currentInspect.http.headers?.['referrer-policy'] || '',
          'permissions-policy': currentInspect.http.headers?.['permissions-policy'] || ''
        },
        redirects: currentInspect.http.redirects || []
      },
      html: {
        title: currentInspect.html?.title,
        forms: (currentInspect.html?.forms || []).map(f => ({
          action: f.action,
          method: f.method,
          inputCount: f.inputs?.length || 0
        })),
        scripts: (currentInspect.html?.scripts || []).map(s => ({
          src: s.src || '',
          isInline: !!s.isInline,
          charLength: s.charLength || 0
        })),
        iframes: (currentInspect.html?.iframes || []).map(f => ({
          src: f.src || '',
          name: f.name || '',
          id: f.id || ''
        })),
        externalDomains: currentInspect.html?.externalDomains || []
      },
      securityHeaders: currentInspect.securityHeaders || {},
      tls: currentInspect.tls ? {
        protocol: currentInspect.tls.protocol || null,
        cipher: currentInspect.tls.cipher || null,
        authorized: currentInspect.tls.authorized,
        authorizationError: currentInspect.tls.authorizationError || null,
        subject: currentInspect.tls.subject || null,
        issuer: currentInspect.tls.issuer || null,
        validFrom: currentInspect.tls.validFrom || null,
        validTo: currentInspect.tls.validTo || null,
        fingerprint256: currentInspect.tls.fingerprint256 || null
      } : null,
      findings: currentInspect.findings || []
    };

    const retentionLimit = Number(config.webEvidenceRetentionLimit) || 20;
    this.appendRecord(storeRecord, retentionLimit);

    return {
      ok: true,
      url,
      snapshotId,
      timestamp: currentInspect.timestamp,
      isFirstScan: !prev,
      diffs,
      current: storeRecord,
      previous: prev ? {
        snapshotId: prev.snapshotId || null,
        timestamp: prev.timestamp,
        http: prev.http,
        html: prev.html,
        securityHeaders: prev.securityHeaders,
        tls: prev.tls,
        findings: prev.findings
      } : null
    };
  }
}
