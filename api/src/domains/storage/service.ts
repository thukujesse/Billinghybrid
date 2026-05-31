import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

function resolveKey(key: string): string {
  const safe = path.posix.normalize(key).replace(/^(\.\.[/\\])+/, '');
  return path.join(config.storage.dir, safe);
}

export async function put(key: string, data: Buffer): Promise<void> {
  const full = resolveKey(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

export async function get(key: string): Promise<Buffer> {
  return fs.readFile(resolveKey(key));
}

export async function exists(key: string): Promise<boolean> {
  try {
    await fs.access(resolveKey(key));
    return true;
  } catch {
    return false;
  }
}
