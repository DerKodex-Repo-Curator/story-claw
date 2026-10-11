import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Keep one provider copy per render process; stage only referenced footage. */
export const createRuntimeAssetStager = (copyAssets: (target: string) => Promise<void>) => {
  let cache: Promise<string> | undefined;
  return async (target: string, sources: string[]): Promise<void> => {
    cache ??= (async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-provider-assets-"));
      await copyAssets(directory);
      return directory;
    })();
    const root = await cache;
    const names = new Set(sources.map((source) => source.replace(/\\/g, "/").replace(/^(?:public\/)?video-footage\/sources\//, "")));
    for (const name of names) {
      if (!name || path.isAbsolute(name) || name.split("/").some((part) => part === ".." || !part)) {
        throw new Error(`Invalid video footage path: ${name}`);
      }
      await fs.access(path.join(root, "video-footage", "sources", name));
    }
    await fs.cp(root, target, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(path.toNamespacedPath(root), path.toNamespacedPath(source)).replace(/\\/g, "/");
        const prefix = "video-footage/sources/";
        if (!relative.startsWith(prefix)) return true;
        const name = relative.slice(prefix.length);
        return [...names].some((selected) => selected === name || selected.startsWith(`${name}/`));
      },
    });
  };
};
