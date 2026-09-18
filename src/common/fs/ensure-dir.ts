import { access, constants, mkdir } from 'node:fs/promises';

/** Creates the directory when missing and checks it is writable. Fails loudly otherwise. */
export async function ensureWritableDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, constants.W_OK);
}

export async function isWritableDirectory(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);

    return true;
  } catch {
    return false;
  }
}
