import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let counter = 0;

/** Write via a temp file and rename, so a crash never leaves half a JSON file. */
export async function atomicWrite(path: string, text: string): Promise<void> {
  counter += 1;
  const tmp = `${path}.${Date.now().toString(36)}${counter}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

/** The file access the stocks server needs; swapped for an in-memory one in tests. */
export interface FileIO {
  /** Rejects when the file does not exist. */
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

export const diskIO: FileIO = {
  read: (path) => readFile(path, "utf8"),
  write: atomicWrite,
};
