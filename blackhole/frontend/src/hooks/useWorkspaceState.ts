import { useRef, useState } from 'react';
import type { ApiClient, AppendTerminal, FileNode } from '../types.ts';
import { updateDirectory, mergeDirectoryPage } from './workspaceTree.ts';

export default function useWorkspaceState(
  client: ApiClient | null,
  appendTerminal: AppendTerminal | undefined,
  setActiveTab: ((tab: string) => void) | undefined
) {
  const [workspacePath, setWorkspacePath] = useState('');
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileContent, setSelectedFileContent] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [rootNextOffset, setRootNextOffset] = useState<number | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [fileTreeError, setFileTreeError] = useState('');
  const generation = useRef(0);
  const pending = useRef(new Map<string, Promise<void>>());

  async function fetchWorkspacePath(): Promise<void> {
    if (!client) return;
    try {
      const data = await client.request('/workspace');
      if (data.path) setWorkspacePath(data.path);
    } catch (error) {
      console.error('Failed to fetch workspace path:', error);
    }
  }

  async function handleChangeWorkspace(): Promise<void> {
    if (!client) return;
    try {
      let selectedPath: string | null = null;
      if (window.blackhole?.selectWorkspace) {
        selectedPath = await window.blackhole.selectWorkspace();
      } else {
        const data = await client.request('/dialog/select-workspace');
        if (!data.canceled) selectedPath = data.path;
      }

      if (selectedPath) {
        const response = await client.request('/workspace', {
          method: 'POST',
          body: JSON.stringify({ path: selectedPath })
        });
        setWorkspacePath(response.path);
        generation.current++;
        pending.current.delete('root');
        fetchFiles();
        appendTerminal?.(`Workspace changed: ${response.path}`, 'success');
      }
    } catch (error) {
      appendTerminal?.(`Workspace change failed: ${(error as Error).message}`, 'error');
    }
  }

  async function fetchFiles(): Promise<void> {
    if (!client) return;
    if (pending.current.has('root')) return pending.current.get('root');
    generation.current++;
    const request = loadDirectory('.', 0, generation.current, true);
    pending.current.set('root', request);
    try { await request; } finally { if (pending.current.get('root') === request) pending.current.delete('root'); }
  }

  async function loadDirectory(path: string, offset: number, version = generation.current, root = path === '.'): Promise<void> {
    if (!client) return;
    const key = `${version}:${path}:${offset}`;
    if (pending.current.has(key)) return pending.current.get(key);
    const operation = (async () => {
      if (root) { setRootLoading(true); setFileTreeError(''); }
      else setFiles(prev => updateDirectory(prev, path, node => ({ ...node, loading: true, error: '' })));
      try {
        const data = await client.request(`/files?path=${encodeURIComponent(path)}&offset=${offset}&limit=200`);
        if (generation.current !== version) return;
        const entries = (Array.isArray(data) ? data : data.entries || []) as FileNode[];
        if (root) {
          setFiles(prev => offset ? mergeDirectoryPage(prev, entries) : entries);
          if (!offset) setExpandedFolders({});
          setRootNextOffset(data.nextOffset ?? null);
        } else setFiles(prev => updateDirectory(prev, path, node => ({ ...node,
          children: offset ? mergeDirectoryPage(node.children || [], entries) : entries,
          childrenLoaded: true, nextOffset: data.nextOffset ?? null, loading: false })));
      } catch (error) {
        if (generation.current !== version) return;
        const message = (error as Error).message;
        if (root) setFileTreeError(message);
        else setFiles(prev => updateDirectory(prev, path, node => ({ ...node, loading: false, error: message })));
        appendTerminal?.(`Failed to read workspace files: ${message}`, 'error');
      } finally { if (root && generation.current === version) setRootLoading(false); }
    })();
    pending.current.set(key, operation);
    try { await operation; } finally { pending.current.delete(key); }
  }

  function findDirectory(nodes: FileNode[], path: string): FileNode | undefined {
    for (const node of nodes) {
      if (node.path === path) return node;
      const found = node.children && findDirectory(node.children, path);
      if (found) return found;
    }
  }

  function loadMoreFiles(path = '.'): void {
    const offset = path === '.' ? rootNextOffset : findDirectory(files, path)?.nextOffset;
    if (offset !== null && offset !== undefined) void loadDirectory(path, offset);
  }

  async function fetchFileContent(filePath: string): Promise<void> {
    if (!client) return;
    try {
      const data = await client.request('/files/read', {
        method: 'POST',
        body: JSON.stringify({ filePath })
      });
      setSelectedFileContent(
        data.content !== undefined
          ? data.content
          : `Unable to read file: ${data.error || 'unknown error'}`
      );
    } catch (error) {
      setSelectedFileContent(`File load failed: ${(error as Error).message}`);
    }
  }

  async function selectFile(filePath: string): Promise<void> {
    setSelectedFile(filePath);
    setActiveTab?.('code');
    appendTerminal?.(`File selected: ${filePath}`, 'log');
    await fetchFileContent(filePath);
  }

  function toggleFolder(path: string): void {
    setExpandedFolders(prev => ({
      ...prev,
      [path]: !prev[path]
    }));
    const directory = findDirectory(files, path);
    if (!expandedFolders[path] && directory && (!directory.childrenLoaded || directory.error)) void loadDirectory(path, 0);
  }

  return {
    workspacePath, setWorkspacePath,
    files, setFiles,
    selectedFile, setSelectedFile,
    selectedFileContent, setSelectedFileContent,
    expandedFolders, setExpandedFolders,
    rootNextOffset, rootLoading, fileTreeError, loadMoreFiles,
    fetchWorkspacePath, handleChangeWorkspace, fetchFiles, fetchFileContent, selectFile, toggleFolder
  };
}
