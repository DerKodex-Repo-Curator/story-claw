import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {assertH3Workspace, h3CompletionKey, needsStaticPanel, prepareH3MasterManifest, completeH3MasterManifest} from "../runner/story-render-policy.js";

test("story video skips static rendering; images-only renders continuation panels too", () => {
  assert.equal(needsStaticPanel(false, true, true), true);
  assert.equal(needsStaticPanel(false, true, false), true);
  assert.equal(needsStaticPanel(false, false, false), false);
  assert.equal(needsStaticPanel(false, false, true), false);
  assert.equal(needsStaticPanel(true, false, false), true);
  assert.equal(needsStaticPanel(true, false, true), false);
});

test("unmarked original clips cannot be mistaken for completed H3 clips", () => {
  assert.doesNotThrow(() => assertH3Workspace(undefined, false));
  assert.throws(() => assertH3Workspace(undefined, true), /原 LTX 视频/);
  assert.throws(() => assertH3Workspace("ltx", true), /原 LTX 视频/);
  assert.doesNotThrow(() => assertH3Workspace("h3", true));
});

test("H3 completion cache changes when references, workflow, duration or framing change", () => {
  const key = h3CompletionKey("plan", "workflow", "16:9", 4);
  assert.equal(key, h3CompletionKey("plan", "workflow", "16:9", 4));
  for (const candidate of [
    h3CompletionKey("changed", "workflow", "16:9", 4),
    h3CompletionKey("plan", "changed", "16:9", 4),
    h3CompletionKey("plan", "workflow", "9:16", 4),
    h3CompletionKey("plan", "workflow", "16:9", 5),
  ]) assert.notEqual(candidate, key);
});

test("failed final packaging can resume its immutable H3 raw, but changed inputs cannot reuse it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "h3-master-"));
  const rawPath = path.join(root, "ep01_raw.mp4");
  const manifestPath = `${rawPath}.h3.json`;
  try {
    await prepareH3MasterManifest(rawPath, manifestPath, "first-panel-inputs");
    await fs.writeFile(rawPath, "original raw fixture");
    // Simulate a failure after raw creation but before final audio/subtitle mux.
    await prepareH3MasterManifest(rawPath, manifestPath, "first-panel-inputs");
    await completeH3MasterManifest(rawPath, manifestPath, "first-panel-inputs");
    await prepareH3MasterManifest(rawPath, manifestPath, "first-panel-inputs");
    await assert.rejects(prepareH3MasterManifest(rawPath, manifestPath, "different-panels"), /母版与当前 H3 镜头不一致/);
    assert.equal(await fs.readFile(rawPath, "utf8"), "original raw fixture");
    await fs.writeFile(rawPath, "changed raw fixture");
    await assert.rejects(prepareH3MasterManifest(rawPath, manifestPath, "first-panel-inputs"), /母版内容已改变/);
    await fs.unlink(manifestPath);
    await assert.rejects(prepareH3MasterManifest(rawPath, manifestPath, "first-panel-inputs"), /母版与当前 H3 镜头不一致/);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
