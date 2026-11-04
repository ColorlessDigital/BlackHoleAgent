import type { PendingSecurityAction, TranslateFn } from '../types.ts';

export default function SecurityGate({
  pendingSecurityAction,
  handleRespondSecurity,
  t
}: {
  pendingSecurityAction: PendingSecurityAction | null;
  handleRespondSecurity: (id: string, decision: string) => void;
  t: TranslateFn;
}) {
  if (!pendingSecurityAction) return null;

  const params = pendingSecurityAction.params || {};
  const commandText = params.command || params.cmd || '';
  const detailText = pendingSecurityAction.tool === 'run_command'
    ? commandText
    : `${t('targetPath')}: ${params.path || ''}\n\n[${t('taskDetails')}]\n${params.content || params.replace || params.replacement || `(${t('blockPatchExecution')})`}`;

  return (
    <div
      className="security-modal-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(5, 5, 8, 0.85)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 99999
      }}
    >
      <div
        className="security-modal-container"
        style={{
          width: '520px',
          background: '#0a0a14',
          border: '2px solid var(--accent-violet)',
          boxShadow: '0 0 30px rgba(168, 85, 247, 0.25), inset 0 0 15px rgba(168, 85, 247, 0.1)',
          borderRadius: '12px',
          padding: '24px',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: 'rgba(168, 85, 247, 0.15)',
              border: '1px solid var(--accent-violet)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              color: 'var(--accent-violet)',
              fontSize: '18px',
              fontWeight: 'bold',
              boxShadow: '0 0 10px rgba(168, 85, 247, 0.3)'
            }}
          >
            !
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <h3 style={{ margin: 0, fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '0.5px', textAlign: 'left' }}>
              {t('securityTitle')}
            </h3>
            <span style={{ fontSize: '10px', color: 'var(--accent-cyan)', fontWeight: 600, textTransform: 'uppercase', textAlign: 'left' }}>
              {t('securitySub')}
            </span>
          </div>
        </div>

        <div
          style={{
            background: 'rgba(248, 113, 113, 0.05)',
            border: '1px solid rgba(248, 113, 113, 0.2)',
            borderRadius: '8px',
            padding: '12px 14px',
            fontSize: '13px',
            color: '#f87171',
            lineHeight: '1.5',
            marginBottom: 20,
            textAlign: 'left'
          }}
        >
          <strong>{t('securityReason')}:</strong> {pendingSecurityAction.reason}
        </div>

        <div className="security-detail-box" style={{ marginBottom: 24, textAlign: 'left' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 500 }}>
            {t('securityDetail')}:{' '}
            <code
              style={{
                color: 'var(--accent-violet)',
                background: 'rgba(168, 85, 247, 0.08)',
                padding: '2px 6px',
                borderRadius: '4px',
                fontFamily: 'monospace'
              }}
            >
              {String(pendingSecurityAction.tool || '').toUpperCase()}
            </code>
          </div>

          <div
            style={{
              background: '#020204',
              border: '1px solid var(--border-cyan)',
              borderRadius: '8px',
              padding: '14px',
              maxHeight: '180px',
              overflowY: 'auto',
              fontFamily: 'Consolas, monospace',
              fontSize: '12.5px',
              color: 'var(--accent-cyan)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              boxShadow: 'inset 0 0 8px rgba(56, 189, 248, 0.05)',
              textAlign: 'left'
            }}
          >
            {detailText}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={() => handleRespondSecurity(pendingSecurityAction.id, 'approve')}
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: '8px',
              border: 'none',
              background: 'linear-gradient(135deg, #10b981, #059669)',
              color: '#fff',
              fontWeight: 600,
              fontSize: '14px',
              cursor: 'pointer',
              transition: 'all 0.2s',
              boxShadow: '0 0 15px rgba(16, 185, 129, 0.3)'
            }}
            type="button"
          >
            {t('securityApprove')}
          </button>

          <button
            onClick={() => handleRespondSecurity(pendingSecurityAction.id, 'reject')}
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: '8px',
              border: 'none',
              background: 'linear-gradient(135deg, #ef4444, #dc2626)',
              color: '#fff',
              fontWeight: 600,
              fontSize: '14px',
              cursor: 'pointer',
              transition: 'all 0.2s',
              boxShadow: '0 0 15px rgba(239, 68, 68, 0.3)'
            }}
            type="button"
          >
            {t('securityReject')}
          </button>
        </div>
      </div>
    </div>
  );
}
