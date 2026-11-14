import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Performs fetch with strict AbortController timeout to prevent upstream stalls.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController();
  const existingSignal = init.signal;
  const onExternalAbort = () => controller.abort();
  if (existingSignal) {
    if (existingSignal.aborted) controller.abort();
    else existingSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (existingSignal) {
      existingSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Atomic file write (write to sibling temp file + chmod + rename) to prevent file corruption.
 */
export async function writeFileAtomic(
  targetPath: string,
  content: string,
  mode = 0o600
): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode });
  try {
    await fs.chmod(tmpPath, mode);
  } catch {
    // Ignore chmod error on filesystems that don't support POSIX modes
  }
  await fs.rename(tmpPath, targetPath);
}
