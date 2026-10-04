import fs from "node:fs/promises";
import path from "node:path";
import {searchWebTool} from "../tools/search-web.js";
import {planEssayMg} from "../runner/mg/planner.js";
import {renderAndAssembleEssayMg} from "../runner/mg/assembler.js";
import {finalizeEpisodeMedia} from "../runner/render.js";
import {postprocessEpisodeVideo} from "../runner/postprocess.js";
import {novelPaths} from "../utils/paths.js";
import type {NovelSelection} from "../ui/select.js";
const sel: NovelSelection = {novelName:"AI热点六条新闻_20260921_无标题",episode:1,nextChapter:1,
  sourcePath:path.resolve("input-ai-hot-20260921"),ethnicity:"",aspectRatio:"16:9",imagesOnly:false,articleType:"essay"};
const url = "https://www.jiemian.com/article/15121160.html";
const highlights = [
  {text:"公司累计负自由现金流规模将达到2780亿美元",at:107.833},
  {text:"同期OpenAI预测的累计收入约为8400亿美元",at:118.236},
  {text:"而仅算力和基础设施一项，到2030年底的开支就将达到约8560亿美元",at:120.016},
  {text:"至2030年营收提升至3500亿美元",at:125.076},
];
const result = await searchWebTool.execute("verify",{url},undefined,undefined,{} as never);
const text = result.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");
for(const h of highlights) if(!text.includes(h.text)) throw new Error(`快照缺少原文：${h.text}`);
const file = novelPaths.mgFunctionCalls(sel.novelName,1);
const records = JSON.parse(await fs.readFile(file,"utf8"));
if(records.some((r:any)=>r.status!=="completed")) throw new Error("等待本轮所有片段完成后再修正");
const record = records.find((r:any)=>r.instanceKey==="web-news-focus::focus::02");
await fs.copyFile(file,`${file}.before-openai-source-correction.json`);
record.arguments = {...record.arguments,url,highlights};
await fs.writeFile(file,JSON.stringify(records,null,2)+"\n");
await planEssayMg(sel,{rerenderInstanceKeys:[record.instanceKey]});
const master = await renderAndAssembleEssayMg(sel);
await finalizeEpisodeMedia(master,novelPaths.episodeAlignedAudio(sel.novelName,1),novelPaths.episodeVideo(sel.novelName,1),novelPaths.globalSubtitlesAss(sel.novelName,1));
await fs.rm(novelPaths.postprocessMarker(sel.novelName,1),{force:true});
await postprocessEpisodeVideo(sel);
console.log("[修正] OpenAI 对应报道及最终成片完成");
