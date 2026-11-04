import type { TranslateFn } from '../types.ts';

export default function CodeSandbox({
  selectedFile,
  selectedFileContent,
  t
}: {
  selectedFile: string | null;
  selectedFileContent: string;
  t: TranslateFn;
}) {
  return (
    <div className="code-viewer" style={{ height: '100%' }}>
      <div className="code-viewer-header">
        <span>
          {t('editingFile')}: {selectedFile || t('noFileSelected')}
        </span>
        {selectedFile && <span style={{ color: '#a855f7' }}>{t('livePreview')}</span>}
      </div>
      <div
        className="code-viewer-content"
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowY: 'auto',
          height: 'calc(100% - 38px)',
          fontFamily: 'Consolas, monospace',
          padding: '12px'
        }}
      >
        {selectedFileContent || t('selectFilePrompt')}
      </div>
    </div>
  );
}
