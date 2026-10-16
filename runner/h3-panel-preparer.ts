import fs from "node:fs/promises";
import path from "node:path";
import {createHash, randomUUID} from "node:crypto";
import {createSession, getSharedResources, runSubAgent} from "../agent.js";
import {novelPaths} from "../utils/paths.js";
import {createH3ReferenceTools, hashH3File, validateH3VideoPrompt, H3_VIDEO_RESTRICTIONS, type H3Source, type H3ReferenceSubmission, type H3SceneSubmission} from "../tools/h3-reference-tools.js";
import {STORY_PANEL_VISUAL_RULES, STORY_CAMERA_MOTION_RULES, storyCameraMotionPolicy} from "./story-prompt-constraints.js";

export type {H3Reference, H3Continuation} from "../tools/h3-reference-tools.js";
export type {H3SceneSubmission} from "../tools/h3-reference-tools.js";
export interface H3ResourceCatalog {text: string; pathMap: Map<string, string>}
export interface H3PanelPlan extends H3ReferenceSubmission {
  version: string;
  fingerprint: string;
  duration: number;
}
export interface PrepareH3PanelOptions {
  panel: any;
  catalog: H3ResourceCatalog;
  currentText: string;
  groupPanelCount?: number;
  fullSceneText: string;
  prevContext: any;
  prevEndPositions: string | null;
  spatialContext: string;
  duration: number;
  outputDir: string;
  planPath: string;
  promptPath: string;
  firstFrame?: string;
  /** Tests may provide a deterministic tool-calling agent without network access. */
  agentRunner?: typeof runSubAgent;
  cropPath?: (id: string) => string;
}
export interface PrepareH3SceneOptions {
  sceneName?: string;
  groups: any[];
  catalog: H3ResourceCatalog;
  fullSceneText: string;
  outputDir: string;
  planPath: string;
  agentRunner?: typeof runSubAgent;
}
const VERSION = "h3-visible-reference-v2";
const MAX_AGENT_TOOL_CALLS = 80;
const MAX_AGENT_MS = 10 * 60_000;
const PANEL_SYSTEM = `你是故事镜头的参考图准备与提示词子 Agent。主 Agent 只调度；你必须实际看图、裁剪、复看和自检，并用 submit_panel_plan 提交结构化结果。没有内置写文件工具。

${STORY_PANEL_VISUAL_RULES}

== 对原 image_prompt / video_prompt 的继承 ==
两份提示词是本镜的既定计划，不是供你随意重设计的参考。继承 image_prompt / shot_type 中的实际入画范围、景别、角度、构图、必要姿态/位置、光线和情绪；继承 video_prompt 中原文支持的主要动作、起止状态和已经规划的合法运镜。场景全局上下文只帮助理解连续性，不扩大本镜取景。裁剪必须服务于这个镜头的完整动作范围，不能因为裁片容易获得就擅自更换景别、角度、主体或动作。若计划与原文、可见范围或共享轴线有冲突，遵循原文和共用约束作最小纠错；确实无法执行则明确失败。
${STORY_CAMERA_MOTION_RULES} 输入 cameraMotionPolicy.slightPullAllowed=false 时不得使用拉远；允许时也仅保留原 video_prompt 已规划的缓慢小幅拉远，不能主动添加。guide 仍仅允许同机位局部推近，不用于拉远。
适配 H3 时剥离旧流程里的“已有静态分镜图”前提与声音/台词原文/画外音说明；保留表达所需的可见姿态、表情或动作，不因剥离声音说明就改写本镜叙事。参考图已有的固定外观无需重复，必要的剧情光线变化仍保留。

流程：先通读当前分镜的静态描述、动态描述和当前原文，确定本镜实际可见主体/部位、起止姿态、一个主要动作及原计划合法运镜。完整场景与上一镜头只用来理解连续性，不把全部在场人物变成入画角色。只有当前 image_prompt 的精确人物标签才允许选人物图；不自行换角色/造型。资料不足明确报告缺口，不冒充完成。

逐张调用 read_reference 查看所选源图的实际像素和原始尺寸，再决定裁剪框；坐标是源图归一化 [x,y,width,height]，不根据缩小预览的像素猜坐标。人物原型/造型图经常是正面全身、侧面全身、背面全身、正脸特写四拼，须裁成符合本镜的一种单体视角。源图实际已经只有合格单体或场景时允许整图，不为裁剪而裁剪。crop_reference 后必须再用 read_reference 读取裁片，审核身份、当前可见范围、完整动作所需部位、必要场景线索及单一视图。每源最多三次裁剪；三次仍不合格则明确失败，不无限尝试。

人物镜头选当前入画角色图与场景图；手/身体局部镜头只用所需部位与袖口等局部，不能带脸或完整人物；环境镜头不选人物。所有景别必须有场景图。裁图覆盖整个镜头动作需要：起止姿态、手拿物件、最终取景，而非只看首帧。近景场景只保留所需局部；机位相关的桌面、窗户等空间线索不能全裁掉。不能凭空补家具、假装裁片里有缺失内容。

共享 spatialContext 是本场景的已审核空间/机位侧别约定，必须遵守。越轴检查用人物在场景里的相对位置、机位在关系轴哪一侧、窗/桌等方位和必要的画面左右关系，不只改视线。不要每个 panel 重新猜机位；不必把空间约定长文全部发视频模型。

只有全部裁图复看审核完毕之后，按最终参考顺序编写一条短英文 video_prompt，使用 <Picture 1> 等说明图的用途。融合原 image_prompt 的必要静态构图与原 video_prompt 的必要动作/运镜；只写当前可见内容，一个原文支持的主要动作，保留原计划必要的景别、角度、剧情光线和合法运镜，不追加表演节拍、复杂运镜、风格、焦距、参考图已提供的外貌服装或全景细节。人物称呼不得与参考图的年龄或性别冲突：“学长/学姐”不译为裸 senior、senior man 或 senior woman；优先用 the young man/woman in <Picture N> 绑定对应的年轻人物，确需交代年级关系时用 upper-year college student。不要重复描写外貌或把原文本来年长的人物改成年轻人。两人外观相近时，用图号明确各自的位置、动作和已有背包/行李的归属，不能把一人的随身物复制给另一人。手特写只写 hand/cuff，不写人物名字、face 或整个人；单人近景不带画外人物的姓名/位置/行为。需要具体动作时写明确正面动作，例如空手食指指向已有文字，不暗示拿笔写字。禁止新增、移动、复制家具；不增加无关人物或道具。原对白、独白和声音由 Story Claw 的 TTS 负责，不把台词原文、画外音说明或配音说明送给 H3。无字幕/文字叠加。

若提供 first_frame，必须 read_reference(id='first_frame') 看实际采用前镜头的尾帧。仅在同机位局部推近、不扩大取景、所需主体和角度已在尾帧里时选 guide，写从该帧继续；参考图仍按需保留。尾帧缺失所需信息或本镜是正反打/换角度/换人物则选 independent 并说明原因。不得裁掉/镜像 first_frame 伪装连续。没有 first_frame 必选 independent。

submit 的 review 五项为你看图后的自检结论，sourceLayout 必须说明实际源图是单体、四拼/多视图、身体局部、场景还是道具；note 简短写出你实际看到的审核依据。四拼源图不能整张提交。若任何一项失败，不提交该图。工具错误后依据错误修正；只有 accepted=true 才算完成。`;
const SCENE_SYSTEM = `你是故事场景的共享空间准备子 Agent。sceneName 是当前地点/当前脚本名，完整原文与 groups 是该场景的上下文；资源目录可能含其他地点，不能把别的场景混入当前空间约定。先根据当前场景名、原文、资源描述找到正确场景源图，再通过 read_reference 实际查看；submit_scene_context 的 scene_name 须照抄 sceneName。只有文字目录不算看图。不要写文件。若当前场景资料缺失，明确失败，不自画、借用另一地点、切回其他视频模型。
结合原文、现有分镜和场景图，以简短文字记录：源图能看到的空间线索；本段人物固定相对位置；关系轴及所有对话镜头机位保持在哪一侧；必要的窗/桌/过道方位；有原文支持才允许改变站位。区分“参考图可见事实”与“本段采用的构图约定”，不要假称空场景图已经锁定人物。只需要几项关键约定，不复述装修细节、光风格、道具清单。不新增/移动/复制家具，不猜图里没显示的反面结构。人物若只有单人镜头也不把其他在场人物强行写入每镜提示词。无法确定的内容明确写未确定及限制；后续 panel 共享本结果，不各自猜轴线。至少实际读一张当前场景图后才能提交。`;

const hashValue = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A real visual agent must terminate even if it keeps reading or ignores a rejected crop. */
const runBoundedAgent: typeof runSubAgent = async (customTools, systemPrompt, taskPrompt, logPrefix = "[H3准备]", _builtinTools = [], cwd = "") => {
  const sessionPath = novelPaths.h3AgentSession(cwd, randomUUID());
  const session = await createSession(sessionPath, customTools, systemPrompt, [], cwd);
  let calls = 0;
  let failure: string | undefined;
  let accepted = false;
  let abortRequested = false;
  let abortCompletion: Promise<void> | undefined;
  let text = "";
  const abort = (reason?: string) => {
    if (reason) failure = reason;
    abortRequested = true;
    abortCompletion ??= session.abort();
    // Keep the promise handled while the prompt is still running; finally awaits it.
    void abortCompletion.catch(() => {});
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start") {
      if (++calls > MAX_AGENT_TOOL_CALLS) abort(`H3 preparation exceeded ${MAX_AGENT_TOOL_CALLS} tool calls`);
      else console.log(`${logPrefix} ${event.toolName}`);
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") text += event.assistantMessageEvent.delta;
    // The submission is persisted by its host tool. Do not ask the model to narrate or keep reviewing it.
    if (event.type === "tool_execution_end" && event.result?.details?.accepted === true && (event.toolName === "submit_panel_plan" || event.toolName === "submit_scene_context")) {
      accepted = true;
      abort();
    }
  });
  const timer = setTimeout(() => abort("H3 visual preparation timed out after 10 minutes"), MAX_AGENT_MS);
  try {
    try {
      await session.prompt(taskPrompt);
    } catch (error) {
      const abortError = error instanceof Error && (error.name === "AbortError" || /^(?:request |operation |agent )?(?:was )?(?:aborted|cancelled|canceled)(?:[.!\s]|$)/i.test(error.message));
      if (!accepted || !abortRequested || failure || !abortError) throw error;
    }
    if (failure) throw new Error(failure);
    return text || "(submitted via Function Calling)";
  } finally {
    clearTimeout(timer);
    unsubscribe();
    try {
      if (abortCompletion) await abortCompletion;
    } finally {
      session.dispose();
    }
  }
};
function sourceKind(file: string): H3Source["kind"] {
  const normalized = file.replace(/\\/g, "/");
  if (/\/characters\//i.test(normalized)) return "character";
  if (/\/scenes\//i.test(normalized)) return "scene";
  return "object";
}
function catalogSources(catalog: H3ResourceCatalog): H3Source[] {
  return [...new Set(catalog.pathMap.values())].map(file => ({
    path: file, sourceTag: path.basename(file, path.extname(file)), kind: sourceKind(file),
  }));
}
async function hashSources(sources: H3Source[]) {
  return Promise.all(sources.map(async source => ({...source, hash: await hashH3File(source.path)})));
}
async function checkVision(runner: typeof runSubAgent | undefined) {
  if (runner) return; // deterministic tests supply image-capable tools directly
  const {model, settingsManager} = await getSharedResources();
  if (settingsManager.getBlockImages()) throw new Error("H3 reference preparation needs actual image input; blockImages is enabled in Agent settings");
  if (!model.input?.includes("image")) throw new Error("Configured Agent model does not support image input for H3 preparation");
}
async function readJson(file: string): Promise<any | undefined> {
  try {return JSON.parse(await fs.readFile(file, "utf8"));} catch {return undefined;}
}
async function cacheReferencesValid(plan: H3PanelPlan, sources: H3Source[], actorTags: string[], firstFrame?: string): Promise<boolean> {
  if (!Array.isArray(plan.references) || !plan.references.length || plan.references.length > 9 || !plan.videoPrompt) return false;
  try {
    validateH3VideoPrompt(plan.videoPrompt, plan.references);
    if (!plan.videoPrompt.includes(H3_VIDEO_RESTRICTIONS) || new Set(plan.references.map(ref => ref.path)).size !== plan.references.length) return false;
    const usedActorTags = new Set<string>();
    let hasScene = false;
    for (const [index, reference] of plan.references.entries()) {
      const source = sources.find(item => item.path === reference.source && item.sourceTag === reference.sourceTag);
      if (!source || !["actor", "body_part", "scene", "object"].includes(reference.role)) return false;
      if (source.kind === "character") {
        if (!["actor", "body_part"].includes(reference.role) || !actorTags.includes(reference.sourceTag)) return false;
        usedActorTags.add(reference.sourceTag);
      } else if (reference.role === "actor" || reference.role === "body_part") return false;
      if (reference.role === "scene") {
        if (source.kind !== "scene") return false;
        hasScene = true;
      }
      if (reference.cropBox !== null && (!Array.isArray(reference.cropBox) || reference.cropBox.length !== 4 || !reference.cropBox.every(Number.isFinite))) return false;
      if (reference.cropBox) {
        const [x, y, w, h] = reference.cropBox;
        if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.00000001 || y + h > 1.00000001) return false;
      } else if (reference.path !== reference.source) return false;
      const review = reference.review;
      if (!review || [review.correctIdentity, review.onlyRequiredContent, review.actionRangeCovered, review.sufficientContext, review.singleView].some(value => value !== true) || !["single_subject", "body_part", "multi_view", "scene", "object"].includes(review.sourceLayout) || !review.note?.trim() || (review.sourceLayout === "multi_view" && !reference.cropBox)) return false;
      if (reference.picture !== index + 1 || reference.reviewedHash !== reference.contentHash || await hashH3File(reference.path) !== reference.contentHash || await hashH3File(reference.source) !== reference.sourceHash) return false;
    }
    if (!hasScene || actorTags.some(tag => !usedActorTags.has(tag))) return false;
    if (!["guide", "independent"].includes(plan.continuation?.strategy) || !plan.continuation.reason?.trim()) return false;
    if (firstFrame && await hashH3File(firstFrame) !== plan.continuation.reviewedFirstFrameHash) return false;
    if (plan.continuation.strategy === "guide" && (!firstFrame || plan.continuation.firstFrame !== firstFrame || !plan.continuation.sameCameraLocalPush || !plan.continuation.requiredContentPresent || await hashH3File(firstFrame) !== plan.continuation.firstFrameHash)) return false;
    return true;
  } catch {return false;}
}

export async function prepareH3Panel(options: PrepareH3PanelOptions): Promise<H3PanelPlan> {
  if (!Number.isFinite(options.duration) || options.duration <= 0) throw new Error("H3 panel duration must be positive");
  const tags = [...new Set([...String(options.panel.image_prompt ?? "").matchAll(/\[([^\]]+)\]/g)].map(match => match[1]))];
  const sources = catalogSources(options.catalog).filter(source => source.kind === "scene" || tags.includes(source.sourceTag));
  for (const tag of tags) {
    if (!sources.some(source => source.sourceTag === tag && source.kind === "character")) throw new Error(`Missing exact visible character resource: ${tag}`);
  }
  if (!sources.some(source => source.kind === "scene")) throw new Error("H3 preparation requires scene resources");
  const snapshots = await hashSources(sources);
  const firstFrameHash = options.firstFrame ? await hashH3File(options.firstFrame) : undefined;
  const input = {
    panel: options.panel, currentText: options.currentText, fullSceneText: options.fullSceneText,
    cameraMotionPolicy: storyCameraMotionPolicy(options.currentText, options.groupPanelCount ?? 1),
    prevContext: options.prevContext, prevEndPositions: options.prevEndPositions, spatialContext: options.spatialContext,
    duration: options.duration, sources: snapshots, firstFrame: options.firstFrame, firstFrameHash,
  };
  const fingerprint = hashValue({version: VERSION, rules: PANEL_SYSTEM, restrictions: "no-furniture-change;no-voiceover;tts-owned", ...input});
  const cached = await readJson(options.planPath) as H3PanelPlan | undefined;
  if (cached?.fingerprint === fingerprint && cached.version === VERSION && await cacheReferencesValid(cached, sources, tags, options.firstFrame)) {
    await fs.mkdir(path.dirname(options.promptPath), {recursive: true});
    await fs.writeFile(options.promptPath, cached.videoPrompt, "utf8");
    return cached;
  }
  await checkVision(options.agentRunner);
  await fs.mkdir(options.outputDir, {recursive: true});
  const tools = createH3ReferenceTools({sources, requiredActorTags: tags, firstFrame: options.firstFrame, cropPath: options.cropPath ?? (id => novelPaths.h3ReferenceFile(options.outputDir, id))});
  const runner = options.agentRunner ?? runBoundedAgent;
  const finalText = await runner(tools.tools, PANEL_SYSTEM, JSON.stringify({
    ...input, sources: tools.sources, firstFrame: options.firstFrame ? "read_reference id=first_frame" : null,
    requiredActorTags: tags, sourceResourceDescriptions: options.catalog.text,
  }), "[H3镜头准备]", [], options.outputDir);
  const prepared = tools.getPanelSubmission();
  if (!prepared) throw new Error(`H3 panel preparation did not pass visual review: ${finalText.slice(0, 500)}`);
  // Reject references/guide that changed while the agent was preparing the prompt.
  for (const snapshot of snapshots) if (await hashH3File(snapshot.path) !== snapshot.hash) throw new Error("H3 source changed during panel preparation");
  if (options.firstFrame && await hashH3File(options.firstFrame) !== firstFrameHash) throw new Error("H3 guide changed during panel preparation");
  const plan: H3PanelPlan = {...prepared, version: VERSION, fingerprint, duration: options.duration};
  await fs.mkdir(path.dirname(options.planPath), {recursive: true});
  await fs.mkdir(path.dirname(options.promptPath), {recursive: true});
  await fs.writeFile(options.planPath, JSON.stringify(plan, null, 2), "utf8");
  await fs.writeFile(options.promptPath, plan.videoPrompt, "utf8");
  return plan;
}

export async function prepareH3SceneContext(options: PrepareH3SceneOptions): Promise<H3SceneSubmission> {
  const sources = catalogSources(options.catalog).filter(source => source.kind === "scene");
  if (!sources.length) throw new Error("Shared H3 scene preparation needs an existing scene reference");
  const snapshots = await hashSources(sources);
  const input = {sceneName: options.sceneName, groups: options.groups, fullSceneText: options.fullSceneText, sources: snapshots};
  const fingerprint = hashValue({version: VERSION, rules: SCENE_SYSTEM, ...input});
  const cached = await readJson(options.planPath);
  if (cached?.version === VERSION && cached.fingerprint === fingerprint && typeof cached.spatialContext === "string" && cached.spatialContext.trim() && cached.sceneName === options.sceneName && Array.isArray(cached.sources) && cached.sources.length && cached.sources.every((source: {path: string; hash: string}) => snapshots.some(snapshot => snapshot.path === source.path && snapshot.hash === source.hash))) return {spatialContext: cached.spatialContext, sources: cached.sources, ...(cached.sceneName ? {sceneName: cached.sceneName} : {})};
  await checkVision(options.agentRunner);
  await fs.mkdir(options.outputDir, {recursive: true});
  const tools = createH3ReferenceTools({sources, sceneOnly: true, sceneName: options.sceneName, cropPath: id => novelPaths.h3ReferenceFile(options.outputDir, id)});
  const runner = options.agentRunner ?? runBoundedAgent;
  const finalText = await runner(tools.tools, SCENE_SYSTEM, JSON.stringify({...input, sources: tools.sources, sourceResourceDescriptions: options.catalog.text}), "[H3场景空间]", [], options.outputDir);
  const context = tools.getSceneSubmission();
  if (!context) throw new Error(`H3 shared scene preparation did not pass image review: ${finalText.slice(0, 500)}`);
  for (const snapshot of snapshots) if (await hashH3File(snapshot.path) !== snapshot.hash) throw new Error("H3 scene source changed during preparation");
  await fs.mkdir(path.dirname(options.planPath), {recursive: true});
  await fs.writeFile(options.planPath, JSON.stringify({...context, version: VERSION, fingerprint}, null, 2), "utf8");
  return context;
}
