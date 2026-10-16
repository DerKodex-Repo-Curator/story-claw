import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function needsStaticPanel(isEssay: boolean, imagesOnly: boolean, continuation: boolean): boolean {
  return imagesOnly || (isEssay && !continuation);
}

/** Unmarked old videos belong to the original LTX route. Do not mix backends. */
export function assertH3Workspace(recorded: unknown, hasVideos: boolean): void {
  if (!hasVideos) return;
  if (recorded !== "h3") {
    throw new Error("该场景已有原 LTX 视频，请在新项目或未渲染的新集使用 H3，避免把旧视频当作 H3 结果复用。");
  }
}

export function h3CompletionKey(planFingerprint: string, workflowHash: string, aspectRatio: string, duration: number): string {
  return createHash("sha256").update(JSON.stringify({version: 1, planFingerprint, workflowHash, aspectRatio, duration})).digest("hex");
}

/** Record immutable story-master inputs before building, so a failed final mux
 * can resume safely while changed panels cannot silently reuse an older raw. */
export async function prepareH3MasterManifest(rawVideoPath: string, manifestPath: string, fingerprint: string): Promise<void> {
  const hasRaw = await fs.access(rawVideoPath).then(() => true, () => false);
  const manifest = await fs.readFile(manifestPath, "utf8").then(text => JSON.parse(text)).catch(() => undefined);
  if (hasRaw) {
    if (manifest?.fingerprint !== fingerprint) {
      throw new Error("该集不可覆盖的原画母版与当前 H3 镜头不一致，请使用新集；停止合成以免复用旧画面。");
    }
    if (manifest.rawHash && createHash("sha256").update(await fs.readFile(rawVideoPath)).digest("hex") !== manifest.rawHash) {
      throw new Error("H3 原画母版内容已改变，停止合成。");
    }
    return;
  }
  await fs.mkdir(path.dirname(manifestPath), {recursive: true});
  await fs.writeFile(manifestPath, `${JSON.stringify({fingerprint}, null, 2)}\n`, "utf8");
}

export async function completeH3MasterManifest(rawVideoPath: string, manifestPath: string, fingerprint: string): Promise<void> {
  const rawHash = createHash("sha256").update(await fs.readFile(rawVideoPath)).digest("hex");
  await fs.writeFile(manifestPath, `${JSON.stringify({fingerprint, rawHash}, null, 2)}\n`, "utf8");
}
