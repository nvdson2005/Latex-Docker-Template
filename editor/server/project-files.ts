import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type { TreeEntry, TextFile } from '../shared/contracts.js';

type CreatableKind = 'source' | 'directory';

export interface ProjectFiles {
  validateSource(path: string, allowMissing?: boolean): Promise<void>;
  list(): Promise<TreeEntry[]>;
  read(path: string): Promise<TextFile>;
  create(path: string, kind: CreatableKind): Promise<TreeEntry>;
  save(path: string, text: string, revision: string): Promise<TextFile>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

class FileError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class RevisionConflict extends FileError {
  constructor(readonly current: TextFile) {
    super(409, 'The file changed on disk');
  }
}

const reservedRoots = new Set([
  'editor', 'docs', 'build', 'export', 'compose.yaml', 'build.sh', 'readme.md', 'spec.md',
]);
const sourceExtensions = new Set(['.tex', '.bib', '.sty', '.cls']);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isProtected(name: string, topLevel: boolean): boolean {
  return name.startsWith('.') || (topLevel && reservedRoots.has(name.toLowerCase()));
}

function isInvalidSegment(segment: string): boolean {
  return !segment || segment === '.' || segment === '..' || !segment.isWellFormed() ||
    /^[a-z]:|[\\\x00-\x1f\x7f]/i.test(segment);
}

function pathSegments(path: string): string[] {
  const segments = path.split('/');
  if (segments.some(isInvalidSegment)) {
    throw new FileError(400, 'Expected a relative project path');
  }
  if (segments.some((segment, index) => isProtected(segment, index === 0))) {
    throw new FileError(403, 'Path is protected');
  }
  return segments;
}

function isSource(path: string): boolean {
  return sourceExtensions.has(extname(path).toLowerCase());
}

function assertOrdinaryEntry(info: Stats): void {
  if (!info.isFile() && !info.isDirectory()) {
    throw new FileError(403, 'Only regular files and directories are accessible');
  }
}

function revisionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fileInfo(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function rethrowFileError(error: unknown): never {
  switch ((error as NodeJS.ErrnoException).code) {
    case 'ENOENT':
    case 'ENOTDIR':
      throw new FileError(404, 'Project entry does not exist');
    case 'EACCES':
    case 'EPERM':
    case 'ELOOP':
      throw new FileError(403, 'Project entry is inaccessible');
    case 'EEXIST':
    case 'ENOTEMPTY':
      throw new FileError(409, 'The target already exists');
    case 'ENAMETOOLONG':
    case 'EINVAL':
      throw new FileError(400, 'Invalid project path');
    default:
      throw error;
  }
}

export function createProjectFiles(projectRoot: string): ProjectFiles {
  const root = resolve(projectRoot);
  let pending: Promise<unknown> = Promise.resolve();

  // Reads wait for already queued mutations. Each mutation runs even if the previous one failed.
  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation).catch(rethrowFileError);
    pending = result.catch(() => undefined);
    return result;
  }

  async function inspect(path: string, allowMissing = false, allowMissingParent = false) {
    const segments = pathSegments(path);
    let absolute = root;
    let info: Stats | undefined;
    for (const [index, segment] of segments.entries()) {
      absolute = join(absolute, segment);
      info = await fileInfo(absolute);
      const last = index === segments.length - 1;
      if (!info) {
        if ((last && allowMissing) || allowMissingParent) break;
        throw new FileError(404, 'Project entry does not exist');
      }
      assertOrdinaryEntry(info);
      if (!last && !info.isDirectory()) {
        throw new FileError(404, 'Parent directory does not exist');
      }
    }
    return { absolute, info };
  }

  async function walk(directory: string, parent: string, entries?: TreeEntry[]): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (isProtected(child.name, !parent) || isInvalidSegment(child.name) ||
          (!child.isDirectory() && !child.isFile())) {
        if (!entries) throw new FileError(403, 'Directory contains a protected entry');
        continue;
      }
      const path = parent ? parent + '/' + child.name : child.name;
      const kind = child.isDirectory() ? 'directory' : isSource(path) ? 'source' : 'asset';
      entries?.push({ path, kind });
      if (kind === 'directory') await walk(join(directory, child.name), path, entries);
    }
  }

  async function readSource(path: string) {
    const { absolute, info } = await inspect(path);
    if (!info?.isFile() || !isSource(path)) {
      throw new FileError(400, 'Expected an editable source file');
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new FileError(403, 'Expected a regular file');
      const bytes = await handle.readFile();
      let text: string;
      try {
        text = utf8.decode(bytes);
      } catch {
        throw new FileError(400, 'File is not valid UTF-8 text');
      }
      if (text.includes('\0')) throw new FileError(400, 'File is not text');
      return { absolute, mode: opened.mode, file: { text, revision: revisionOf(bytes) } };
    } finally {
      await handle.close();
    }
  }

  return {
    async validateSource(path, allowMissing = false) {
      await pending;
      const { info } = await inspect(path, allowMissing, allowMissing);
      if (!isSource(path) || (info && !info.isFile())) throw new FileError(400, 'Expected an editable source file');
    },
    async list() {
      await pending;
      const entries: TreeEntry[] = [];
      await walk(root, '', entries).catch(rethrowFileError);
      return entries;
    },
    async read(path) {
      await pending;
      return (await readSource(path).catch(rethrowFileError)).file;
    },
    create(path, kind) {
      return mutate(async () => {
        const { absolute, info } = await inspect(path, true);
        if (info) throw new FileError(409, 'The target already exists');
        if (kind === 'directory') {
          await mkdir(absolute);
        } else {
          if (!isSource(path)) throw new FileError(400, 'Unsupported source extension');
          await (await open(absolute, 'wx')).close();
        }
        return { path, kind };
      });
    },
    save(path, text, revision) {
      return mutate(async () => {
        if (text.includes('\0') || !text.isWellFormed()) {
          throw new FileError(400, 'Expected UTF-8 text');
        }
        const original = await readSource(path);
        if (original.file.revision !== revision) throw new RevisionConflict(original.file);
        const bytes = Buffer.from(text, 'utf8');
        const temporary = join(dirname(original.absolute), '.latex-save-' + randomUUID());
        const handle = await open(temporary, 'wx', 0o600);
        try {
          try {
            await handle.writeFile(bytes);
            await handle.chmod(original.mode & 0o7777);
          } finally {
            await handle.close();
          }
          const current = await readSource(path);
          if (current.file.revision !== revision) throw new RevisionConflict(current.file);
          if ((current.mode & 0o7777) !== (original.mode & 0o7777)) {
            throw new FileError(409, 'File permissions changed on disk');
          }
          await rename(temporary, current.absolute);
          return { text, revision: revisionOf(bytes) };
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
    move(from, to) {
      return mutate(async () => {
        const source = await inspect(from);
        const target = await inspect(to, true);
        if (target.info) throw new FileError(409, 'The target already exists');
        if (source.info?.isDirectory()) {
          if (to.startsWith(from + '/')) throw new FileError(400, 'Cannot move a directory into itself');
          await walk(source.absolute, from);
        } else if (isSource(from) !== isSource(to) ||
                   (!isSource(from) && extname(from).toLowerCase() !== extname(to).toLowerCase())) {
          throw new FileError(400, 'Unsupported destination extension');
        }
        if (await fileInfo(target.absolute)) throw new FileError(409, 'The target already exists');
        await rename(source.absolute, target.absolute);
      });
    },
    remove(path) {
      return mutate(async () => {
        const { absolute, info } = await inspect(path);
        if (info?.isDirectory()) {
          await walk(absolute, path);
          await rm(absolute, { recursive: true });
        } else {
          await unlink(absolute);
        }
      });
    },
  };
}
