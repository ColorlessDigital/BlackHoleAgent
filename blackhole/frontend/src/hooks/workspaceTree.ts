import type { FileNode } from '../types.ts';

export function updateDirectory(nodes: FileNode[], path: string, update: (node: FileNode) => FileNode): FileNode[] {
  return nodes.map(node => node.path === path ? update(node)
    : node.children ? { ...node, children: updateDirectory(node.children, path, update) } : node);
}

export function mergeDirectoryPage(previous: FileNode[], next: FileNode[]): FileNode[] {
  return [...new Map([...previous, ...next].map(node => [node.path, node])).values()];
}

const FILE_CHANGING_TOOLS = new Set(['write_file', 'patch_file', 'patch_lines', 'apply_patch_transaction', 'run_command']);
export function shouldRefreshWorkspace(tool: string, success = true): boolean {
  return success && FILE_CHANGING_TOOLS.has(tool);
}
