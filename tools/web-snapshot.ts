import {createHash, randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {PATHS} from "../utils/paths.js";

const normalizedUrl = (value: string): string => {
  const url = new URL(value.trim());
  url.hash = "";
  return url.href;
};

export const webSnapshotPathForUrl = (url: string): string => {
  const digest = createHash("sha256").update(normalizedUrl(url)).digest("hex");
  return path.join(PATHS.webSnapshots, `${digest}.html`);
};

const writeSnapshotFile = async (target: string, html: string): Promise<void> => {
  await fs.mkdir(path.dirname(target), {recursive: true});
  const temporary = `${target}.${randomUUID()}.next`;
  try {
    await fs.writeFile(temporary, html, "utf8");
    // Publish a complete file without replacing the first snapshot (also on Windows).
    await fs.link(temporary, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  } finally {
    await fs.rm(temporary, {force: true});
  }
};

/** Persist one translated snapshot and aliases for the requested/final URL. */
export const saveWebSnapshot = async (urls: readonly string[], html: string): Promise<void> => {
  for (const url of [...new Set(urls.map(normalizedUrl).filter(Boolean))]) {
    await writeSnapshotFile(webSnapshotPathForUrl(url), html);
  }
};

/** Resolve the snapshot created by search_web({url}) without exposing its internal filename. */
export const resolveWebSnapshot = async (url: string): Promise<string | undefined> => {
  const target = webSnapshotPathForUrl(url);
  try {
    const stat = await fs.stat(target);
    return stat.isFile() && stat.size > 0 ? target : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const readWebSnapshot = async (url: string): Promise<string | undefined> => {
  const target = await resolveWebSnapshot(url);
  return target ? fs.readFile(target, "utf8") : undefined;
};
