import fs from "node:fs/promises";
import path from "node:path";
import {planEssayMg} from "../runner/mg/planner.js";
import {renderAndAssembleEssayMg} from "../runner/mg/assembler.js";
import {finalizeEpisodeMedia} from "../runner/render.js";
import {postprocessEpisodeVideo} from "../runner/postprocess.js";
import {novelPaths} from "../utils/paths.js";
import {markStage} from "../utils/progress.js";
import type {NovelSelection} from "../ui/select.js";

const sel: NovelSelection = {
  novelName: "AI热点六条新闻_20260921_无标题", episode: 1, nextChapter: 1,
  sourcePath: path.resolve("input-ai-hot-20260921"), ethnicity: "",
  aspectRatio: "16:9", imagesOnly: false, articleType: "essay",
};
const ep = novelPaths.episodeDir(sel.novelName, 1);
const recordsPath = novelPaths.mgFunctionCalls(sel.novelName, 1);
const records = JSON.parse(await fs.readFile(recordsPath, "utf8")) as Array<{instanceKey: string; htmlTag: string}>;
const backup = path.join(ep, `snapshot-rerun-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await fs.mkdir(backup);
for (const name of ["mg", "ep01.mp4", ".postprocess_done.json", "mg_annotation.html"]) {
  await fs.cp(path.join(ep, name), path.join(backup, name), {recursive: true});
}
console.log(`[重新生成] 备份：${backup}`);
const keys = records.filter(r => !["sc-video", "sc-longtake"].includes(r.htmlTag)).map(r => r.instanceKey);
await planEssayMg(sel, {replanInstanceKeys: keys});
await markStage(sel.novelName, 1, "mgPlan", "done");
const master = await renderAndAssembleEssayMg(sel);
await markStage(sel.novelName, 1, "mgRender", "done");
await finalizeEpisodeMedia(master, novelPaths.episodeAlignedAudio(sel.novelName, 1),
  novelPaths.episodeVideo(sel.novelName, 1), novelPaths.globalSubtitlesAss(sel.novelName, 1));
await fs.rm(novelPaths.postprocessMarker(sel.novelName, 1), {force: true});
await postprocessEpisodeVideo(sel);
await markStage(sel.novelName, 1, "finalize", "done");
console.log(`[重新生成] 完成：${novelPaths.episodeVideo(sel.novelName, 1)}`);
