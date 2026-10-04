import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {syncBuiltinESMExports} from "node:module";
// Run-specific renderer options; production source and installed modules are unchanged.
// Remotion's default is half the detected CPU count. Cap only this process.
os.availableParallelism = () => 2;
syncBuiltinESMExports();
console.log("[整片合成] 本次运行限制为单并发，临时文件位于 D 盘");
const {renderAndAssembleEssayMg} = await import("../runner/mg/assembler.js");
const {finalizeEpisodeMedia} = await import("../runner/render.js");
const {postprocessEpisodeVideo} = await import("../runner/postprocess.js");
const {novelPaths} = await import("../utils/paths.js");
const {markStage} = await import("../utils/progress.js");
const sel = {novelName:"AI热点六条新闻_20260921_无标题",episode:1,nextChapter:1,
  sourcePath:path.resolve("input-ai-hot-20260921"),ethnicity:"",aspectRatio:"16:9",imagesOnly:false,articleType:"essay" as const};
const master = await renderAndAssembleEssayMg(sel);
await markStage(sel.novelName,1,"mgRender","done");
await finalizeEpisodeMedia(master,novelPaths.episodeAlignedAudio(sel.novelName,1),novelPaths.episodeVideo(sel.novelName,1),novelPaths.globalSubtitlesAss(sel.novelName,1));
await fs.rm(novelPaths.postprocessMarker(sel.novelName,1),{force:true});
await postprocessEpisodeVideo(sel);
await markStage(sel.novelName,1,"finalize","done");
console.log(`[完成] ${novelPaths.episodeVideo(sel.novelName,1)}`);
