import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import sharp from "sharp";
import {Type} from "@sinclair/typebox";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";

export type H3ReferenceRole = "actor" | "body_part" | "scene" | "object";
export type H3CropBox = [number, number, number, number];
export interface H3ReferenceReview {
  correctIdentity: boolean;
  onlyRequiredContent: boolean;
  actionRangeCovered: boolean;
  sufficientContext: boolean;
  singleView: boolean;
  sourceLayout: "single_subject" | "body_part" | "multi_view" | "scene" | "object";
  note: string;
}
export interface H3Source {path: string; sourceTag: string; kind: "character" | "scene" | "object"}
export interface H3Reference {
  path: string;
  source: string;
  sourceTag: string;
  sourceHash: string;
  contentHash: string;
  cropBox: H3CropBox | null;
  role: H3ReferenceRole;
  picture: number;
  reviewedHash: string;
  review: H3ReferenceReview;
}
export interface H3Continuation {
  strategy: "guide" | "independent";
  reason: string;
  firstFrame?: string;
  firstFrameHash?: string;
  reviewedFirstFrameHash?: string;
  sameCameraLocalPush: boolean;
  requiredContentPresent: boolean;
}
export interface H3ReferenceSubmission {
  references: H3Reference[];
  videoPrompt: string;
  continuation: H3Continuation;
}
export interface H3SceneSubmission {spatialContext: string; sources: Array<{path: string; hash: string}>; sceneName?: string}
interface Artifact {
  id: string;
  path: string;
  source: H3Source;
  sourceHash: string;
  contentHash: string;
  cropBox: H3CropBox | null;
  readHash?: string;
}
export interface H3ReferenceToolOptions {
  sources: H3Source[];
  cropPath: (id: string) => string;
  requiredActorTags?: string[];
  firstFrame?: string;
  sceneOnly?: boolean;
  sceneName?: string;
  maxCropsPerSource?: number;
  maxToolCalls?: number;
}

export const hashH3File = async (file: string): Promise<string> =>
  createHash("sha256").update(await fs.readFile(file)).digest("hex");
const textResult = (value: unknown) => ({content: [{type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value)}], details: {}});
const checkId = (id: string) => {
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(id)) throw new Error("Invalid reference id");
};
export const H3_VIDEO_RESTRICTIONS = "Do not add, move or duplicate furniture. No subtitles, captions, watermarks or text overlays.";

export function validateH3VideoPrompt(prompt: string, references: Array<{role: H3ReferenceRole; picture: number}>) {
  if (!prompt || prompt.length > 2600 || /[\u3400-\u9fff]/u.test(prompt)) throw new Error("Prompt must be concise English without character filenames or Chinese dialogue");
  if (/voice[ -]?over|narrat(?:or|ion)|\bin Chinese\b/i.test(prompt)) throw new Error("Do not send voiceover explanations or TTS dialogue to H3");
  if (/\[[^\]]+\]/u.test(prompt)) throw new Error("Unresolved source tags in H3 prompt");
  const pictures = [...prompt.matchAll(/<Picture\s+(\d+)>/g)].map(match => Number(match[1]));
  if (pictures.some(n => n < 1 || n > references.length) || references.some((ref, index) => ref.picture !== index + 1 || !pictures.includes(ref.picture))) throw new Error("Picture tags must match the selected reference order exactly");
  const positivePrompt = prompt.replace(/\bno (?:face|whole person)(?:\s*(?:,|or)\s*(?:face|whole person))*/gi, "");
  if (references.some(ref => ref.role === "body_part") && !references.some(ref => ref.role === "actor") && /\b(actor|person|man|woman|face|portrait)\b/i.test(positivePrompt)) throw new Error("Body-part-only shot must not describe the whole actor");
}

/** Tools hold the evidence of actual image reads. Text claims cannot replace these records. */
export function createH3ReferenceTools(options: H3ReferenceToolOptions) {
  const artifacts = new Map<string, Artifact>();
  const cropCounts = new Map<string, number>();
  let panelSubmission: H3ReferenceSubmission | undefined;
  let sceneSubmission: H3SceneSubmission | undefined;
  let guideHash: string | undefined;
  let toolCalls = 0;
  const initialSources = options.sources.map((source, index) => {
    const id = `source_${index + 1}`;
    artifacts.set(id, {id, path: source.path, source, sourceHash: "", contentHash: "", cropBox: null});
    return {id, ...source};
  });
  const requireRead = async (id: string): Promise<Artifact> => {
    const artifact = artifacts.get(id);
    if (!artifact) throw new Error(`Unknown reference: ${id}`);
    const hash = await hashH3File(artifact.path);
    if (!artifact.readHash || artifact.readHash !== hash) throw new Error(`Read the actual image first: ${id}`);
    if (await hashH3File(artifact.source.path) !== artifact.sourceHash) throw new Error(`Source changed after review: ${id}`);
    return artifact;
  };
  const wrap = (run: (params: any) => Promise<any>) => async (_callId: string, params: any) => {
    if (++toolCalls > (options.maxToolCalls ?? 80)) return {...textResult("ERROR: H3 visual preparation tool-call budget exhausted"), isError: true};
    try {return await run(params);} catch (error) {return {...textResult(`ERROR: ${error instanceof Error ? error.message : String(error)}`), isError: true};}
  };
  const readReference: ToolDefinition = {
    name: "read_reference", label: "查看 H3 参考图",
    description: "Read a listed source, generated crop, or first_frame as an actual image. Returns original dimensions; crop coordinates are normalized against this original image, never the preview size.",
    parameters: Type.Object({id: Type.String()}),
    execute: wrap(async ({id}) => {
      const artifact = artifacts.get(id);
      const imagePath = id === "first_frame" ? options.firstFrame : artifact?.path;
      if (!imagePath) throw new Error(`Unknown image id: ${id}`);
      const input = await fs.readFile(imagePath);
      const contentHash = createHash("sha256").update(input).digest("hex");
      const metadata = await sharp(input).metadata();
      if (!metadata.width || !metadata.height) throw new Error("Image has no dimensions");
      const preview = await sharp(input).resize({width: 1600, height: 1600, fit: "inside", withoutEnlargement: true}).png().toBuffer();
      if (artifact) {
        const sourceHash = await hashH3File(artifact.source.path);
        if (artifact.cropBox !== null && sourceHash !== artifact.sourceHash) throw new Error("Source changed after crop creation; prepare a new crop");
        artifact.sourceHash = sourceHash;
        artifact.contentHash = contentHash;
        artifact.readHash = contentHash;
      } else guideHash = contentHash;
      return {content: [
        {type: "text" as const, text: JSON.stringify({id, width: metadata.width, height: metadata.height, hash: contentHash, sourceTag: artifact?.source.sourceTag, cropBox: artifact?.cropBox})},
        {type: "image" as const, data: preview.toString("base64"), mimeType: "image/png"},
      ], details: {}};
    }),
  };
  const cropReference: ToolDefinition = {
    name: "crop_reference", label: "裁剪 H3 参考图",
    description: "Crop a previously read SOURCE image with [x,y,width,height] in normalized 0–1 original-image coordinates. Inspect the resulting id with read_reference before submitting. Maximum three crops per source.",
    parameters: Type.Object({source_id: Type.String(), id: Type.String(), box: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()])}),
    execute: wrap(async ({source_id, id, box}) => {
      if (options.sceneOnly) throw new Error("Scene context only needs source reads; cropping is unavailable");
      checkId(id);
      if (artifacts.has(id) || id === "first_frame") throw new Error("Reference id already exists");
      const source = await requireRead(source_id);
      if (source.cropBox !== null) throw new Error("Crop only original sources; do not cascade crop coordinates");
      const count = cropCounts.get(source_id) ?? 0;
      if (count >= (options.maxCropsPerSource ?? 3)) throw new Error("Crop retry limit reached; report missing information instead");
      cropCounts.set(source_id, count + 1);
      if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) throw new Error("Invalid normalized crop box");
      const [x, y, w, h] = box as H3CropBox;
      if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.00000001 || y + h > 1.00000001) throw new Error("Crop box is outside the source image");
      const metadata = await sharp(source.path).metadata();
      const width = metadata.width!, height = metadata.height!;
      const left = Math.floor(x * width), top = Math.floor(y * height);
      const right = Math.min(width, Math.ceil((x + w) * width)), bottom = Math.min(height, Math.ceil((y + h) * height));
      if (right - left < 16 || bottom - top < 16) throw new Error("Crop is too small to be a usable visual reference (minimum 16 pixels per side)");
      const output = options.cropPath(id);
      if (path.resolve(output) === path.resolve(source.path)) throw new Error("Cannot overwrite source reference");
      await fs.mkdir(path.dirname(output), {recursive: true});
      await sharp(source.path).extract({left, top, width: right - left, height: bottom - top}).png().toFile(output);
      artifacts.set(id, {id, path: output, source: source.source, sourceHash: source.sourceHash, contentHash: await hashH3File(output), cropBox: box as H3CropBox});
      return textResult({id, width: right - left, height: bottom - top, reviewRequired: true});
    }),
  };
  const submitPanel: ToolDefinition = {
    name: "submit_panel_plan", label: "提交已审核 H3 镜头",
    description: "Submit only after reading sources and re-reading all chosen crops. Reference order is Picture order. Required exact character tags must be covered; a character sheet must be cropped to one view. Write one concise English prompt only AFTER crop review. For first_frame choose guide only if the viewed frame supports the same-camera local push-in; otherwise independent with a reason.",
    parameters: Type.Object({
      references: Type.Array(Type.Object({id: Type.String(), role: Type.Union([Type.Literal("actor"), Type.Literal("body_part"), Type.Literal("scene"), Type.Literal("object")]), source_tag: Type.String(), review: Type.Object({correctIdentity: Type.Boolean(), onlyRequiredContent: Type.Boolean(), actionRangeCovered: Type.Boolean(), sufficientContext: Type.Boolean(), singleView: Type.Boolean(), sourceLayout: Type.Union([Type.Literal("single_subject"), Type.Literal("body_part"), Type.Literal("multi_view"), Type.Literal("scene"), Type.Literal("object")]), note: Type.String({minLength: 1, maxLength: 600})})}), {minItems: 1, maxItems: 9}),
      video_prompt: Type.String({minLength: 1, maxLength: 2400}),
      continuation: Type.Object({strategy: Type.Union([Type.Literal("guide"), Type.Literal("independent")]), reason: Type.String({minLength: 1}), sameCameraLocalPush: Type.Boolean(), requiredContentPresent: Type.Boolean()}),
    }),
    execute: wrap(async (params) => {
      if (options.sceneOnly) throw new Error("Submit scene context instead");
      if (panelSubmission) throw new Error("Panel plan has already been accepted");
      if (!Array.isArray(params.references) || params.references.length < 1 || params.references.length > 9) throw new Error("H3 needs 1–9 references");
      const seen = new Set<string>();
      const references: H3Reference[] = [];
      const actorTags = new Set<string>();
      for (const item of params.references) {
        if (seen.has(item.id)) throw new Error("Duplicate reference id");
        seen.add(item.id);
        const artifact = await requireRead(item.id);
        if (item.source_tag !== artifact.source.sourceTag) throw new Error("Source tag does not match reference provenance");
        if (!["actor", "body_part", "scene", "object"].includes(item.role)) throw new Error("Invalid reference role");
        if (!item.review || ["correctIdentity", "onlyRequiredContent", "actionRangeCovered", "sufficientContext", "singleView"].some(key => item.review[key] !== true)) throw new Error("Reference visual review has not passed");
        if (!["single_subject", "body_part", "multi_view", "scene", "object"].includes(item.review.sourceLayout) || !String(item.review.note ?? "").trim()) throw new Error("Report the actual source layout and visual review evidence");
        if (item.review.sourceLayout === "multi_view" && artifact.cropBox === null) throw new Error("Multi-view source must be cropped to the required single view");
        if (artifact.source.kind === "character") {
          if (!["actor", "body_part"].includes(item.role)) throw new Error("Character reference cannot pretend to be a scene or object");
          if (!(options.requiredActorTags ?? []).includes(artifact.source.sourceTag)) throw new Error("This character is not visible in the current panel");
          actorTags.add(artifact.source.sourceTag);
        } else if (item.role === "actor" || item.role === "body_part") throw new Error("Actor reference must come from the exact character resource");
        if (item.role === "scene" && artifact.source.kind !== "scene") throw new Error("Scene reference must come from the scene catalog");
        references.push({path: artifact.path, source: artifact.source.path, sourceTag: artifact.source.sourceTag, sourceHash: artifact.sourceHash, contentHash: artifact.contentHash, cropBox: artifact.cropBox, role: item.role, picture: references.length + 1, reviewedHash: artifact.readHash!, review: {...item.review}});
      }
      if (!(options.requiredActorTags ?? []).every(tag => actorTags.has(tag))) throw new Error("Missing exact visible character reference");
      if (!references.some(ref => ref.role === "scene")) throw new Error("A scene reference is required for every shot type");
      let prompt = String(params.video_prompt ?? "").trim();
      if (prompt.length > 2400) throw new Error("H3 submitted prompt is too long");
      validateH3VideoPrompt(prompt, references);
      const continuation: H3Continuation = {strategy: params.continuation?.strategy, reason: String(params.continuation?.reason ?? "").trim(), sameCameraLocalPush: params.continuation?.sameCameraLocalPush === true, requiredContentPresent: params.continuation?.requiredContentPresent === true};
      if (!["guide", "independent"].includes(continuation.strategy) || !continuation.reason) throw new Error("Explicit continuation strategy and reason required");
      if (options.firstFrame) {
        const actualGuideHash = await hashH3File(options.firstFrame);
        if (!guideHash || guideHash !== actualGuideHash) throw new Error("Read the actual first_frame before choosing a continuation strategy");
        continuation.reviewedFirstFrameHash = guideHash;
        if (continuation.strategy === "guide") {
          if (params.continuation.sameCameraLocalPush !== true || params.continuation.requiredContentPresent !== true) throw new Error("Guide must support the same-camera local push-in and required visible content");
          continuation.firstFrame = options.firstFrame;
          continuation.firstFrameHash = guideHash;
        }
      } else if (continuation.strategy === "guide") throw new Error("No guide frame was supplied");
      if (!prompt.includes(H3_VIDEO_RESTRICTIONS)) prompt += `\n\n${H3_VIDEO_RESTRICTIONS}`;
      panelSubmission = {references, videoPrompt: prompt, continuation};
      return {...textResult({accepted: true, pictures: references.map(({picture, sourceTag, role}) => ({picture, sourceTag, role}))}), details: {accepted: true}};
    }),
  };
  const submitScene: ToolDefinition = {
    name: "submit_scene_context", label: "提交共享空间约定",
    description: "After reading the actual scene images, submit shared spatial/camera-side facts for all panels in this scene. Facts must distinguish image evidence from a chosen staging rule. No generated furniture or guessed reverse-side layout.",
    parameters: Type.Object({source_ids: Type.Array(Type.String(), {minItems: 1}), scene_name: Type.Optional(Type.String()), spatial_context: Type.String({minLength: 1, maxLength: 3000})}),
    execute: wrap(async ({source_ids, scene_name, spatial_context}) => {
      if (!options.sceneOnly || sceneSubmission) throw new Error("Scene context submission is unavailable");
      if (options.sceneName && scene_name !== options.sceneName) throw new Error("Scene context must match the current scene/script name");
      if (!Array.isArray(source_ids) || !source_ids.length || new Set(source_ids).size !== source_ids.length) throw new Error("List distinct reviewed scene sources");
      const sources = [];
      for (const id of source_ids) {
        const artifact = await requireRead(id);
        if (artifact.source.kind !== "scene") throw new Error("Scene context needs scene resources only");
        sources.push({path: artifact.source.path, hash: artifact.sourceHash});
      }
      const spatialContext = String(spatial_context ?? "").trim();
      if (!spatialContext || spatialContext.length > 3000) throw new Error("Invalid scene context");
      sceneSubmission = {spatialContext, sources, ...(options.sceneName ? {sceneName: options.sceneName} : {})};
      return {...textResult({accepted: true}), details: {accepted: true}};
    }),
  };
  return {
    tools: options.sceneOnly ? [readReference, submitScene] : [readReference, cropReference, submitPanel],
    sources: initialSources,
    getPanelSubmission: () => panelSubmission,
    getSceneSubmission: () => sceneSubmission,
  };
}
