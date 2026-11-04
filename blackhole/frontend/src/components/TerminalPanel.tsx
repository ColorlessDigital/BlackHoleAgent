import React from 'react';
import type { TerminalLine, TranslateFn } from '../types.ts';

const TerminalPanel = React.memo(function TerminalPanel({
  terminalLines,
  setTerminalLines,
  terminalEndRef,
  bottomPanelHeight,
  t
}: {
  terminalLines: TerminalLine[];
  setTerminalLines: React.Dispatch<React.SetStateAction<TerminalLine[]>>;
  terminalEndRef: React.RefObject<HTMLDivElement | null>;
  bottomPanelHeight: number;
  t: TranslateFn;
}) {
  return (
    <div
      className="terminal-container"
      style={{
        height: `${bottomPanelHeight}px`,
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(5, 5, 8, 0.6)',
        borderTop: '1px solid rgba(255, 255, 255, 0.05)',
        overflow: 'hidden'
      }}
    >
      <div className="terminal-header" style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
        <span>{t('activityLogs')}</span>
        <button
          className="btn-save-settings"
          style={{ padding: '4px 10px', fontSize: 11 }}
          onClick={() => setTerminalLines([])}
          type="button"
        >
          {t('clearLogs')}
        </button>
      </div>
      <div className="terminal-logs" style={{ flex: 1, overflowY: 'auto' }}>
        {terminalLines.map((line, index) => {
          const displayText = line.i18nKey ? t(line.i18nKey) : line.text;
          const isSystem = (displayText || '').startsWith('[System]');
          const systemStyle = isSystem ? { color: '#c084fc', fontWeight: 'bold' } : {};
          return (
            <div
              key={`${index}-${line.text}`}
              className={`terminal-line ${line.type || 'log'}`}
              style={systemStyle}
            >
              {line.type === 'command' && '> '}
              {displayText}
            </div>
          );
        })}
        <div ref={terminalEndRef} />
      </div>
    </div>
  );
});

export default TerminalPanel;
