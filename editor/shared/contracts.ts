export type FileKind = 'directory' | 'source' | 'asset';
export type TreeEntry = { path: string; kind: FileKind };
export type TextFile = { text: string; revision: string };
