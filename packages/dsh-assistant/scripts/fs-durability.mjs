import { open } from 'node:fs/promises';

export async function syncDirectory(directory) {
  // Windows FlushFileBuffers cannot sync directories opened with read access.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
