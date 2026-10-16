import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import sharp from "sharp";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import {createH3ReferenceTools, type H3Source} from "../tools/h3-reference-tools.js";
import {prepareH3Panel, prepareH3SceneContext, type PrepareH3PanelOptions} from "../runner/h3-panel-preparer.js";

const review = {correctIdentity: true, onlyRequiredContent: true, actionRangeCovered: true, sufficientContext: true, singleView: true, sourceLayout: "multi_view", note: "Viewed original four-panel source and crop contains only the required frontal actor, including his hand."};
const sceneReview = {...review, sourceLayout: "scene", note: "Viewed the scene reference; table and window establish the required camera-side cues."};
const independent = {strategy: "independent", reason: "New shot", sameCameraLocalPush: false, requiredContentPresent: false};
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-prepare-"));
  const actor = path.join(root, "characters", "Poirot_原型.png");
  const scene = path.join(root, "scenes", "餐车.png");
  await fs.mkdir(path.dirname(actor), {recursive: true});
  await fs.mkdir(path.dirname(scene), {recursive: true});
  await sharp({create: {width: 400, height: 200, channels: 3, background: "red"}}).png().toFile(actor);
  await sharp({create: {width: 400, height: 200, channels: 3, background: "blue"}}).png().toFile(scene);
  const sources: H3Source[] = [{path: actor, sourceTag: "Poirot_原型", kind: "character"}, {path: scene, sourceTag: "餐车", kind: "scene"}];
  return {root, actor, scene, sources};
}
async function call(tools: ToolDefinition[], name: string, params: unknown): Promise<any> {
  const tool = tools.find(item => item.name === name)!;
  return await (tool.execute as any)("test", params, undefined, undefined, undefined);
}
const submission = (actorId = "actor_crop") => ({
  references: [{id: actorId, role: "actor", source_tag: "Poirot_原型", review}, {id: "source_2", role: "scene", source_tag: "餐车", review: sceneReview}],
  video_prompt: "<Picture 1> supplies the actor. <Picture 2> supplies the background. Close shot, the actor stays seated on screen left. Fixed camera; he points at the letters.",
  continuation: independent,
});
async function prepareTools(data: Awaited<ReturnType<typeof fixture>>, firstFrame?: string) {
  const bundle = createH3ReferenceTools({sources: data.sources, requiredActorTags: ["Poirot_原型"], cropPath: id => path.join(data.root, "crops", `${id}.png`), firstFrame});
  await call(bundle.tools, "read_reference", {id: "source_1"});
  await call(bundle.tools, "read_reference", {id: "source_2"});
  await call(bundle.tools, "crop_reference", {source_id: "source_1", id: "actor_crop", box: [0, 0, 0.25, 1]});
  return bundle;
}

test("requires real source read, crop, crop re-read and review before acceptance", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = createH3ReferenceTools({sources: data.sources, requiredActorTags: ["Poirot_原型"], cropPath: id => path.join(data.root, `${id}.png`)});
  assert.equal((await call(bundle.tools, "crop_reference", {source_id: "source_1", id: "crop", box: [0, 0, 0.25, 1]})).isError, true);
  const read = await call(bundle.tools, "read_reference", {id: "source_1"});
  assert.equal(read.content[1].type, "image");
  assert.equal(JSON.parse(read.content[0].text).width, 400);
  await call(bundle.tools, "read_reference", {id: "source_2"});
  await call(bundle.tools, "crop_reference", {source_id: "source_1", id: "actor_crop", box: [0, 0, 0.25, 1]});
  assert.equal((await call(bundle.tools, "submit_panel_plan", submission())).isError, true);
  assert.equal(bundle.getPanelSubmission(), undefined);
  await call(bundle.tools, "read_reference", {id: "actor_crop"});
  assert.equal((await call(bundle.tools, "submit_panel_plan", submission())).isError, undefined);
  const plan = bundle.getPanelSubmission()!;
  assert.deepEqual(plan.references.map(ref => ref.picture), [1, 2]);
  assert.deepEqual(plan.references[0].cropBox, [0, 0, 0.25, 1]);
  assert.match(plan.videoPrompt, /Do not add, move or duplicate furniture/);
});

test("rejects crop boundaries and bounds failed attempts", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = createH3ReferenceTools({sources: data.sources, cropPath: id => path.join(data.root, `${id}.png`)});
  await call(bundle.tools, "read_reference", {id: "source_1"});
  for (const [index, box] of [[-0.1, 0, 0.2, 1], [0.9, 0, 0.2, 1], [0, 0, 0.001, 1]].entries()) {
    assert.equal((await call(bundle.tools, "crop_reference", {source_id: "source_1", id: `crop_${index}`, box})).isError, true);
  }
  assert.match((await call(bundle.tools, "crop_reference", {source_id: "source_1", id: "crop_4", box: [0, 0, 0.25, 1]})).content[0].text, /retry limit/);
});

test("tag provenance, visible character completeness and picture order are enforced", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = await prepareTools(data);
  await call(bundle.tools, "read_reference", {id: "actor_crop"});
  const badTag = submission(); badTag.references[0].source_tag = "McQueen_原型";
  assert.equal((await call(bundle.tools, "submit_panel_plan", badTag)).isError, true);
  const badPicture = submission(); badPicture.video_prompt += " <Picture 3>";
  assert.equal((await call(bundle.tools, "submit_panel_plan", badPicture)).isError, true);
  const missing = submission(); missing.references.shift();
  assert.match((await call(bundle.tools, "submit_panel_plan", missing)).content[0].text, /Missing exact/);
  const failedReview = submission(); failedReview.references[0].review = {...review, actionRangeCovered: false};
  assert.match((await call(bundle.tools, "submit_panel_plan", failedReview)).content[0].text, /visual review/);
});

test("multi-view originals cannot be submitted whole, and total tool calls are bounded", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = createH3ReferenceTools({sources: data.sources, requiredActorTags: ["Poirot_原型"], maxToolCalls: 4, cropPath: id => path.join(data.root, `${id}.png`)});
  await call(bundle.tools, "read_reference", {id: "source_1"});
  await call(bundle.tools, "read_reference", {id: "source_2"});
  assert.match((await call(bundle.tools, "submit_panel_plan", submission("source_1"))).content[0].text, /Multi-view/);
  await call(bundle.tools, "read_reference", {id: "source_1"});
  assert.match((await call(bundle.tools, "read_reference", {id: "source_1"})).content[0].text, /budget exhausted/);
});

test("body-part shot rejects full actor descriptions and English prompt rejects TTS explanations", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = await prepareTools(data); await call(bundle.tools, "read_reference", {id: "actor_crop"});
  const body = submission(); body.references[0].role = "body_part";
  assert.match((await call(bundle.tools, "submit_panel_plan", body)).content[0].text, /whole actor/);
  body.video_prompt = "<Picture 1> supplies only the hand and cuff. <Picture 2> supplies the tabletop. Empty index finger points at the existing line. Fixed camera. No face or whole person.";
  assert.equal((await call(bundle.tools, "submit_panel_plan", {...body, video_prompt: body.video_prompt + " A voiceover explains this."})).isError, true);
  assert.equal((await call(bundle.tools, "submit_panel_plan", body)).isError, undefined);
});

test("supplied guide must actually be read and pass local push review", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = await prepareTools(data, data.scene); await call(bundle.tools, "read_reference", {id: "actor_crop"});
  const params = {...submission(), continuation: {...independent, strategy: "guide"}};
  assert.match((await call(bundle.tools, "submit_panel_plan", params)).content[0].text, /first_frame/);
  await call(bundle.tools, "read_reference", {id: "first_frame"});
  assert.match((await call(bundle.tools, "submit_panel_plan", params)).content[0].text, /local push/);
  params.continuation.sameCameraLocalPush = true; params.continuation.requiredContentPresent = true;
  assert.equal((await call(bundle.tools, "submit_panel_plan", params)).isError, undefined);
  assert.equal(bundle.getPanelSubmission()!.continuation.firstFrame, data.scene);
  assert.equal(bundle.getPanelSubmission()!.continuation.reviewedFirstFrameHash, bundle.getPanelSubmission()!.continuation.firstFrameHash);
});

test("insufficient guide may choose independent and records the actual guide review", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = await prepareTools(data, data.scene);
  await call(bundle.tools, "read_reference", {id: "actor_crop"});
  await call(bundle.tools, "read_reference", {id: "first_frame"});
  const params = {...submission(), continuation: {...independent, reason: "Required actor face is absent from the viewed first frame; use an independent shot."}};
  assert.equal((await call(bundle.tools, "submit_panel_plan", params)).isError, undefined);
  assert.equal(bundle.getPanelSubmission()!.continuation.strategy, "independent");
  assert.equal(bundle.getPanelSubmission()!.continuation.firstFrame, undefined);
  assert.match(bundle.getPanelSubmission()!.continuation.reviewedFirstFrameHash!, /^[a-f0-9]{64}$/);
});

test("edited crop/source cannot reuse old image read evidence", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = await prepareTools(data); await call(bundle.tools, "read_reference", {id: "actor_crop"});
  await sharp({create: {width: 100, height: 200, channels: 3, background: "green"}}).png().toFile(path.join(data.root, "crops", "actor_crop.png"));
  assert.match((await call(bundle.tools, "submit_panel_plan", submission())).content[0].text, /Read the actual/);
  await call(bundle.tools, "read_reference", {id: "actor_crop"});
  await sharp({create: {width: 400, height: 200, channels: 3, background: "white"}}).png().toFile(data.actor);
  assert.match((await call(bundle.tools, "read_reference", {id: "actor_crop"})).content[0].text, /Source changed/);
});

test("scene context cannot accept text claims without actual image read", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = createH3ReferenceTools({sources: [data.sources[1]], sceneOnly: true, cropPath: id => path.join(data.root, `${id}.png`)});
  const params = {source_ids: ["source_1"], spatial_context: "Table beside window; use the aisle side for this dialogue."};
  assert.equal((await call(bundle.tools, "submit_scene_context", params)).isError, true);
  await call(bundle.tools, "read_reference", {id: "source_1"});
  assert.equal((await call(bundle.tools, "submit_scene_context", params)).isError, undefined);
});

test("scene context names the current scene rather than adopting a different location", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  const bundle = createH3ReferenceTools({sources: [data.sources[1]], sceneOnly: true, sceneName: "餐车", cropPath: id => path.join(data.root, `${id}.png`)});
  await call(bundle.tools, "read_reference", {id: "source_1"});
  const params = {source_ids: ["source_1"], scene_name: "包厢", spatial_context: "Window side table"};
  assert.match((await call(bundle.tools, "submit_scene_context", params)).content[0].text, /current scene/);
  assert.equal((await call(bundle.tools, "submit_scene_context", {...params, scene_name: "餐车"})).isError, undefined);
  assert.equal(bundle.getSceneSubmission()!.sceneName, "餐车");
});

test("panel preparation caches only exact inputs and reviewed file hashes", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  let runs = 0;
  const receivedInputs: any[] = [];
  const agentRunner: NonNullable<PrepareH3PanelOptions["agentRunner"]> = async (tools, _systemPrompt, taskPrompt) => {
    runs++;
    receivedInputs.push(JSON.parse(taskPrompt));
    await call(tools, "read_reference", {id: "source_1"});
    await call(tools, "read_reference", {id: "source_2"});
    await call(tools, "crop_reference", {source_id: "source_1", id: "actor_crop", box: [0, 0, 0.25, 1]});
    await call(tools, "read_reference", {id: "actor_crop"});
    assert.equal((await call(tools, "submit_panel_plan", submission())).isError, undefined);
    return "accepted";
  };
  const options: PrepareH3PanelOptions = {
    panel: {image_prompt: "[Poirot_原型] seated on left", video_prompt: "Points at letters"}, catalog: {text: "resources", pathMap: new Map([[data.actor, data.actor], [data.scene, data.scene]])},
    currentText: "Points", fullSceneText: "Conversation", prevContext: null, prevEndPositions: null,
    spatialContext: "Table window, aisle side", duration: 3, outputDir: path.join(data.root, "plan"), planPath: path.join(data.root, "plan", "plan.json"), promptPath: path.join(data.root, "plan", "prompt.txt"), agentRunner,
  };
  const first = await prepareH3Panel(options);
  // The visual preparer must receive both original plans and continuity, not just images.
  assert.deepEqual(receivedInputs[0].panel, options.panel);
  assert.equal(receivedInputs[0].currentText, options.currentText);
  assert.equal(receivedInputs[0].spatialContext, options.spatialContext);
  assert.equal(receivedInputs[0].cameraMotionPolicy.slightPullAllowed, false);
  assert.equal((await prepareH3Panel(options)).fingerprint, first.fingerprint); assert.equal(runs, 1);
  await prepareH3Panel({...options, spatialContext: "Different camera side"}); assert.equal(runs, 2);
  await fs.writeFile(first.references[0].path, "broken");
  await prepareH3Panel({...options, spatialContext: "Different camera side"}); assert.equal(runs, 3);
  const newDynamic = await prepareH3Panel({...options, panel: {...options.panel, video_prompt: "Keeps the hand still"}});
  assert.notEqual(newDynamic.fingerprint, first.fingerprint); assert.equal(runs, 4);
  assert.equal(receivedInputs[3].panel.video_prompt, "Keeps the hand still");
  const newStatic = await prepareH3Panel({...options, panel: {...options.panel, image_prompt: "[Poirot_原型] seated on right"}});
  assert.notEqual(newStatic.fingerprint, first.fingerprint); assert.equal(runs, 5);
  assert.equal(receivedInputs[4].panel.image_prompt, "[Poirot_原型] seated on right");
});

test("scene preparation cache changes with source pixels and panel state", async t => {
  const data = await fixture(); t.after(() => fs.rm(data.root, {recursive: true, force: true}));
  let runs = 0;
  const options = {sceneName: "餐车", groups: [{panels: []}], catalog: {text: "scene", pathMap: new Map([[data.scene, data.scene]])}, fullSceneText: "conversation", outputDir: path.join(data.root, "scene-plan"), planPath: path.join(data.root, "scene-plan", "scene.json"), agentRunner: (async tools => {
    runs++; await call(tools, "read_reference", {id: "source_1"});
    await call(tools, "submit_scene_context", {scene_name: "餐车", source_ids: ["source_1"], spatial_context: "Keep camera on aisle side of table."});
    return "accepted";
  }) as NonNullable<PrepareH3PanelOptions["agentRunner"]>};
  const result = await prepareH3SceneContext(options);
  assert.match(result.spatialContext, /aisle/); assert.equal(result.sources[0].path, data.scene); assert.equal(result.sceneName, "餐车");
  assert.deepEqual(await prepareH3SceneContext(options), result); assert.equal(runs, 1);
  await sharp({create: {width: 400, height: 200, channels: 3, background: "green"}}).png().toFile(data.scene);
  await prepareH3SceneContext(options); assert.equal(runs, 2);
});
