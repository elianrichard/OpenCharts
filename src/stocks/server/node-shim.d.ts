/**
 * The repo does not install @types/node (the app is browser code), but this
 * folder runs inside the Vite dev server. These are the few Node APIs it uses,
 * typed narrowly. Function-only declarations merge cleanly with @types/node if
 * it is ever added.
 */

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options: { force?: boolean; recursive?: boolean }): Promise<void>;
}

declare module "node:path" {
  export function resolve(...segments: string[]): string;
  export function join(...segments: string[]): string;
  export function dirname(path: string): string;
}
