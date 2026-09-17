import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MODE_PRIVATE_DIR = 0o700;
export const MODE_PRIVATE_FILE = 0o600;

export async function readJson<T = unknown>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export interface WriteJsonOptions {
  fileMode?: number;
  dirMode?: number;
}

export async function writeJson(
  path: string,
  value: unknown,
  options: WriteJsonOptions = {},
): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
  });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(options.fileMode === undefined ? {} : { mode: options.fileMode }),
  });
}

export type PathKind = "any" | "file" | "dir";

/** Presence check via stat; never reads the file. */
export async function pathExists(path: string, kind: PathKind = "any"): Promise<boolean> {
  try {
    const s = await stat(path);
    if (kind === "file") {
      return s.isFile();
    }
    if (kind === "dir") {
      return s.isDirectory();
    }
    return true;
  } catch {
    return false;
  }
}

export const fileExists = (path: string) => pathExists(path, "file");
export const dirExists = (path: string) => pathExists(path, "dir");
