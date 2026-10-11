import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {syncBuiltinESMExports} from "node:module";
import {createHash} from "node:crypto";
import {novelPaths} from "../utils/paths.js";
import {readProgress, markStage} from "../utils/progress.js";
import type {NovelSelection} from "../ui/select.js";
import type {VisualFunctionRecord} from "../runner/mg/types.js";

const [novelName, episodeArg = "1", expectedHash, sourceContextPath, resumeArg] = process.argv.slice(2);
const replanPrefix = "--replan-instances=";
const replanInstanceKeys = resumeArg?.startsWith(replanPrefix)
  ? resumeArg.slice(replanPrefix.length).split(",").map((key) => key.trim())
  : undefined;
if (replanInstanceKeys?.some((key) => !key)) throw new Error("Replan continuation requires nonempty instance keys");
if (resumeArg && !replanInstanceKeys && !["--resume", "--finalize-only"].includes(resumeArg)) throw new Error("Unknown continuation option");
if (resumeArg && !expectedHash) throw new Error("Resume requires the reviewed HTML hash");
const episode = Number(episodeArg);
if (!novelName || !Number.isInteger(episode) || episode < 1) {
  throw new Error("Usage: node --import tsx scripts/rerender-essay-mg.ts <project> [episode] [HTML SHA256]");
}

// Keep software rendering within this machine's available memory.
os.availableParallelism = () => 2;
syncBuiltinESMExports();

const progress = await readProgress(novelName);
if (progress.article_type !== "essay" || !progress.source_path) {
  throw new Error("MG rerender requires an existing essay project with source_path");
}
const sel: NovelSelection = {
  novelName, episode, nextChapter: progress.episodes?.[String(episode)]?.chapter ?? episode,
  sourcePath: progress.source_path, ethnicity: "", aspectRatio: progress.aspect_ratio ?? "16:9",
  imagesOnly: false, articleType: "essay",
};
const epDir = novelPaths.episodeDir(novelName, episode);
const htmlPath = novelPaths.mgAnnotation(novelName, episode);
const originalHtml = await fs.readFile(htmlPath);
const hash = createHash("sha256").update(originalHtml).digest("hex");
if (expectedHash && hash !== expectedHash.toLowerCase()) throw new Error("HTML hash differs from the reviewed input");
const {validateMgAnnotationHtml} = await import("../runner/mg/html.js");
const annotation = validateMgAnnotationHtml(originalHtml.toString("utf8"), await fs.readFile(novelPaths.cleanedText(novelName, episode), "utf8"));
if (/<sc-(?:video|longtake)\b/i.test(originalHtml.toString("utf8"))) {
  throw new Error("Use the full runner for projects that generate remote video clips");
}
await fs.access(novelPaths.episodeAlignedAudio(novelName, episode));
await fs.access(novelPaths.articleTimeline(novelName, episode));

const backup = path.join(epDir, `timing-rerun-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await fs.mkdir(backup);
for (const source of [
  novelPaths.mgDir(novelName, episode), novelPaths.episodeVideo(novelName, episode),
  novelPaths.coversDir(novelName, episode), novelPaths.postprocessMarker(novelName, episode),
  htmlPath, novelPaths.progress(novelName),
]) {
  try { await fs.access(source); } catch { continue; }
  await fs.cp(source, path.join(backup, path.basename(source)), {recursive: true});
}
console.log(`[重新生成] 备份：${backup}`);
console.log(`[重新生成] ${annotation.instanceCount} 个实例；HTML SHA256=${hash}`);

const {planEssayMg} = await import("../runner/mg/planner.js");
const {renderAndAssembleEssayMg} = await import("../runner/mg/assembler.js");
const {finalizeEpisodeMedia} = await import("../runner/render.js");
const {generateEpisodeCovers} = await import("../runner/cover.js");
const {postprocessEpisodeVideo} = await import("../runner/postprocess.js");
let previousCalls: VisualFunctionRecord[] = [];
try {
  previousCalls = JSON.parse(await fs.readFile(novelPaths.mgFunctionCalls(novelName, episode), "utf8")) as VisualFunctionRecord[];
  if (!Array.isArray(previousCalls)) previousCalls = [];
} catch {
  // A reviewed HTML plus the aligned audio and article timeline is enough to
  // create the first MG plan.  Do not make an old Function Call cache a
  // hidden prerequisite for the approved-HTML continuation entry point.
}
const sources = previousCalls.flatMap((record) => {
  const url = record.arguments.url;
  return typeof url === "string" && /^https?:\/\//.test(url) ? [`${record.instanceKey}: ${url}`] : [];
});
const previousSourceContext = sources.length ? [
  "以下是本项目之前已核验的网页来源。先直接调用 search_web({url}) 读取对应页面，可使用已有正文快照，并从读取结果逐字选取定位短语。原链接读取失败时再搜索替代来源，避免重复泛搜同一条新闻。",
  ...sources,
  "仍须为当前 HTML 的全部实例重新调用其对应工具；以上只提供来源链接，不复用旧 Function Call。",
].join("\n") : undefined;
// First approved-HTML runs may have verified sources before any calls exist.
// This is planning input only; the planner still executes every native tool.
const reviewedSourceContext = sourceContextPath ? await fs.readFile(path.resolve(sourceContextPath), "utf8") : undefined;
const planningContext = [previousSourceContext, reviewedSourceContext].filter(Boolean).join("\n\n") || undefined;
if (reviewedSourceContext) console.log(`[重新生成] 来源审核上下文 SHA256=${createHash("sha256").update(reviewedSourceContext).digest("hex")}`);
console.log(`[重新生成] 提供 ${sources.length} 个已核验来源；全部 Function Call 仍重新生成`);
if (resumeArg === "--finalize-only") {
  if (progress.episodes?.[String(episode)]?.stages?.mgRender !== "done" ||
      previousCalls.length !== annotation.instanceCount || previousCalls.some((record) => record.status !== "completed")) {
    throw new Error("Finalize continuation requires completed MG rendering and every reviewed HTML call");
  }
  await fs.access(novelPaths.episodeVideo(novelName, episode));
} else {
  await planEssayMg(sel, replanInstanceKeys
    ? {replanInstanceKeys, planningContext}
    : {all: resumeArg !== "--resume", planningContext});
  await markStage(novelName, episode, "mgPlan", "done");
  const master = await renderAndAssembleEssayMg(sel);
  await markStage(novelName, episode, "mgRender", "done");
  await finalizeEpisodeMedia(master, novelPaths.episodeAlignedAudio(novelName, episode),
    novelPaths.episodeVideo(novelName, episode), novelPaths.globalSubtitlesAss(novelName, episode));
}
await generateEpisodeCovers(sel);
await fs.rm(novelPaths.postprocessMarker(novelName, episode), {force: true});
await postprocessEpisodeVideo(sel);

const records = JSON.parse(await fs.readFile(novelPaths.mgFunctionCalls(novelName, episode), "utf8")) as VisualFunctionRecord[];
if (records.length !== annotation.instanceCount || records.some((record) => record.status !== "completed")) {
  throw new Error("Rerender did not complete every reviewed HTML instance");
}
if (records.some((record) => ["at", "startTime", "endTime"].some((field) => field in record.arguments))) {
  throw new Error("Function Call still contains model-owned whole-instance timing");
}
if (!(await fs.readFile(htmlPath)).equals(originalHtml)) throw new Error("Reviewed HTML changed during rerender");
const after = await readProgress(novelName);
if (after.next_chapter !== progress.next_chapter || JSON.stringify(after.adapted) !== JSON.stringify(progress.adapted)) {
  throw new Error("Rerender unexpectedly changed chapter progress");
}
await markStage(novelName, episode, "finalize", "done");
console.log(`[重新生成] 完成：${novelPaths.episodeVideo(novelName, episode)}`);
console.log(`[重新生成] ${records.length} 个新 Function Call 完成；HTML 与章节进度核验通过`);
