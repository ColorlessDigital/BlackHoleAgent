import React from 'react';
import type { FileNode, TranslateFn } from '../types.ts';

const FileExplorer = React.memo(function FileExplorer({
  files,
  expandedFolders,
  selectedFile,
  toggleFolder,
  selectFile,
  t, rootNextOffset, rootLoading, error, loadMore
}: {
  files: FileNode[];
  expandedFolders: Record<string, boolean>;
  selectedFile: string | null;
  toggleFolder: (path: string) => void;
  selectFile: (path: string) => void;
  t: TranslateFn;
  rootNextOffset?: number | null;
  rootLoading?: boolean;
  error?: string;
  loadMore?: (path?: string) => void;
}) {
  const renderTree = (nodes: FileNode[]): React.ReactNode[] => {
    return nodes.map((node) => {
      if (node.isDir) {
        const isExpanded = Boolean(expandedFolders[node.path]);
        return (
          <div key={node.path} style={{ marginLeft: 10 }}>
            <button
              className="tree-node"
              onClick={() => toggleFolder(node.path)}
              type="button"
              title={node.path}
              style={{ width: '100%', textAlign: 'left' }}
            >
              <span className="tree-folder-icon">{isExpanded ? 'v' : '>'} [dir]</span>
              <span style={{ fontWeight: 500 }}>{node.name}</span>
            </button>
            {isExpanded && node.children && renderTree(node.children)}
            {isExpanded && node.loading && <div role="status">{t('loading')}</div>}
            {isExpanded && node.error && <div role="alert">{node.error}</div>}
            {isExpanded && node.nextOffset != null && <button type="button" className="tree-node" disabled={node.loading} onClick={() => loadMore?.(node.path)}>{t('loadMore')}</button>}
          </div>
        );
      }

      const isSelected = selectedFile === node.path;
      return (
        <button
          key={node.path}
          className={`tree-node ${isSelected ? 'active' : ''}`}
          style={{ marginLeft: 20, width: 'calc(100% - 20px)', textAlign: 'left' }}
          onClick={() => selectFile(node.path)}
          type="button"
          title={node.path}
        >
          <span className="tree-file-icon">[file]</span>
          <span>{node.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="file-tree" style={{ flex: 1, overflowY: 'auto' }}>
      {error && <div role="alert">{error}</div>}
      {files.length > 0
        ? renderTree(files)
        : <div style={{ padding: 10, fontSize: 12, color: '#64748b' }}>{t('emptyWorkspace')}</div>}
      {rootLoading && <div role="status">{t('loading')}</div>}
      {rootNextOffset != null && <button type="button" className="tree-node" disabled={rootLoading} onClick={() => loadMore?.()}>{t('loadMore')}</button>}
    </div>
  );
});

export default FileExplorer;
