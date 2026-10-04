import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, {after} from "node:test";

// Explicit integration test: network translation and a local headless browser are required.
// Uses only the public template Provider, as the production renderer does.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-snapshot-integration-"));
const previousWorkDir = process.env.STORY_CLAW_WORK_DIR;
const previousTemplateDir = process.env.STORY_CLAW_MG_TEMPLATES_DIR;
process.env.STORY_CLAW_WORK_DIR = directory;
// npm run build:pack --prefix ../story-claw-templates before this test.
// Never accidentally test an older globally installed Provider.
process.env.STORY_CLAW_MG_TEMPLATES_DIR ??= path.resolve(import.meta.dirname, "../../story-claw-templates/build/mg-template-pack");
const {searchWebTool} = await import("../tools/search-web.js");
const {readWebSnapshot, saveWebSnapshot} = await import("../tools/web-snapshot.js");
const {PATHS} = await import("../utils/paths.js");
const {loadMgTemplateProvider} = await import("../utils/mg-template-runtime.js");
const provider = await loadMgTemplateProvider();
const outputDirectory = process.env.STORY_CLAW_WEB_SNAPSHOT_TEST_OUTPUT
  ? path.resolve(process.env.STORY_CLAW_WEB_SNAPSHOT_TEST_OUTPUT)
  : path.join(directory, "captures");

after(async () => {
  if (previousWorkDir === undefined) delete process.env.STORY_CLAW_WORK_DIR;
  else process.env.STORY_CLAW_WORK_DIR = previousWorkDir;
  if (previousTemplateDir === undefined) delete process.env.STORY_CLAW_MG_TEMPLATES_DIR;
  else process.env.STORY_CLAW_MG_TEMPLATES_DIR = previousTemplateDir;
  await fs.rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});

const readPage = async (url: string): Promise<string> => {
  const result = await searchWebTool.execute("snapshot-integration", {url}, undefined, undefined, {} as never);
  const block = result.content[0];
  assert.equal(block.type, "text");
  if (block.type !== "text") throw new Error("expected webpage text");
  assert.doesNotMatch(block.text, /^ERROR:/);
  return block.text;
};

const prepare = async (template: "web-page-focus" | "web-news-focus", url: string, phrase: string, captureDirectory: string) => {
  const isNews = template === "web-news-focus";
  const call = provider.resolveCall({
    name: isNews ? "create_web_news_focus" : "create_web_page_focus",
    arguments: {
      group: "focus", order: null, at: 0, url, entrance: "fade",
      [isNews ? "highlights" : "focus"]: [{text: phrase, at: 0}],
    },
  });
  await provider.prepareRuntimeAssets({
    layers: [{
      id: template, instance: call.instanceKey, htmlTag: template, group: call.group,
      layerRole: call.layerRole, startFrame: 0, endFrame: 90, durationFrames: 90,
      timelineOffsetFrames: 0, sourceText: phrase, render: call.render,
    }],
    webSnapshotDirectory: PATHS.webSnapshots,
    resolveImage: async (source: string) => {
      await fs.mkdir(captureDirectory, {recursive: true});
      const target = path.join(captureDirectory, path.basename(source));
      await fs.copyFile(source, target);
      return target;
    },
  });
  return (call.render as {spec: {capture: {
    baseImage: string;
    highlightedImage?: string;
    focus?: Array<{text: string; rects: Array<{width: number; height: number}>}>;
    highlights?: Array<{text: string; rects: Array<{width: number; height: number}>}>;
  }}}).spec.capture;
};

test("real English page is translated once, read back verbatim, and captured by URL through the Provider", {timeout: 180_000}, async () => {
  const url = "https://www.w3.org/History/19921103-hypertext/hypertext/WWW/TheProject.html";
  const content = await readPage(url);
  // Check the translation of the known English introduction, not merely the presence of Chinese UI.
  assert.doesNotMatch(content, /Everything there is online|linked directly or indirectly|executive\s+summary of the project/);
  const introduction = content.split(/\n\s*\n/).find((paragraph) => /W3/.test(paragraph)
    && /(?:在线|网上|线上).*信息|信息.*(?:在线|网上|线上)/s.test(paragraph));
  assert.ok(introduction, `the English paragraph about online W3 information must be translated; received: ${content}`);
  assert.match(introduction, /直接/);
  assert.match(introduction, /间接/);
  assert.match(introduction, /摘要|概要/);
  const phrase = introduction.trim().slice(0, 160);
  assert.ok(phrase, "translated introductory sentence must be available for exact copying");
  const snapshot = await readWebSnapshot(url);
  assert.ok(snapshot);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => assert.fail("rereading the snapshot must not fetch or translate")) as typeof fetch;
  try {
    assert.equal(await readPage(`${url}#introduction`), content);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const capture = await prepare("web-page-focus", url, phrase, path.join(outputDirectory, "w3c"));
  assert.equal(capture.focus?.[0].text, phrase);
  assert.ok(capture.focus[0].rects.some((rect) => rect.width > 0 && rect.height > 0));
  assert.ok((await fs.stat(capture.baseImage)).size > 1000);
  assert.equal(await readWebSnapshot(url), snapshot, "capture must consume the exact saved translation");
  await fs.writeFile(path.join(outputDirectory, "w3c", "body.txt"), content, "utf8");
  await fs.writeFile(path.join(outputDirectory, "w3c", "snapshot.html"), snapshot, "utf8");
  if (process.env.STORY_CLAW_WEB_SNAPSHOT_TEST_RENDER === "1") {
    const {renderVisualTagTemplateClip} = await import("../runner/mg/renderer.js");
    const {FFPROBE_PATH} = await import("../utils/media-binaries.js");
    const {execFile} = await import("node:child_process");
    const {promisify} = await import("node:util");
    const call = provider.resolveCall({name: "create_web_page_focus", arguments: {
      group: "focus", order: null, at: 0, url, entrance: "fade", focus: [{text: phrase, at: 0.5}],
    }});
    const videoPath = path.join(outputDirectory, "w3c", "web-page-focus.mp4");
    await renderVisualTagTemplateClip({novelName: "快照集成测试", episode: 1} as never,
      call.instanceKey, call.render, 1280, 720, 90, 30, videoPath);
    const {stdout} = await promisify(execFile)(FFPROBE_PATH, ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=nb_frames,width,height", "-of", "json", videoPath]);
    const stream = JSON.parse(stdout).streams[0];
    assert.equal(Number(stream.nb_frames), 90);
    assert.equal(stream.width, 1280);
    assert.equal(stream.height, 720);
    assert.equal(await readWebSnapshot(url), snapshot, "render must not translate the page again");
  }
});

test("both focus templates freeze snapshot scripts and reject text missing from that snapshot", {timeout: 120_000}, async () => {
  const url = "https://www.reuters.com/technology/snapshot-regression-fixture";
  const phrase = "这里是必须保持不变的中文定位文字";
  await saveWebSnapshot([url], `<!doctype html><html><head><meta charset="utf-8"><title>快照回归测试</title></head>
    <body><article><h1>快照回归测试</h1><p>这是一份只用于测试的页面，${phrase}，用于确认保存的译文不会在捕获时被网站脚本改回英文。</p></article>
    <script>document.querySelector('article').textContent = 'The original site script overwrote the translation.';</script></body></html>`);
  for (const template of ["web-page-focus", "web-news-focus"] as const) {
    const capture = await prepare(template, url, phrase, path.join(outputDirectory, template));
    const anchor = (capture.focus ?? capture.highlights)?.[0];
    assert.equal(anchor?.text, phrase);
    assert.ok(anchor?.rects.some((rect) => rect.width > 0 && rect.height > 0));
    assert.equal(Boolean(capture.highlightedImage), template === "web-news-focus");
    await assert.rejects(() => prepare(template, url, "这段文字根本不在网页中", path.join(directory, "missing")), /CAPTURE_FAILED.*WEB_FOCUS_TEXT_NOT_FOUND.*search_web/s);
  }
});
