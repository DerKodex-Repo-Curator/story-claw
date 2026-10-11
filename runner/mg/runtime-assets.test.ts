import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {createRuntimeAssetStager} from "./runtime-assets.js";

test("retains selected footage and copies the provider only once", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "mg-assets-test-"));
  let copies = 0;
  const stage = createRuntimeAssetStager(async (root) => {
    copies++;
    await fs.mkdir(path.join(root, "video-footage/sources"), {recursive: true});
    await fs.writeFile(path.join(root, "video-footage/sources/selected.mp4"), "selected");
    await fs.writeFile(path.join(root, "video-footage/sources/unused.mp4"), "unused");
    await fs.writeFile(path.join(root, "logo.svg"), "logo");
  });
  await stage(path.join(target, "first"), ["video-footage/sources/selected.mp4"]);
  assert.equal(await fs.readFile(path.join(target, "first/video-footage/sources/selected.mp4"), "utf8"), "selected");
  await assert.rejects(fs.access(path.join(target, "first/video-footage/sources/unused.mp4")));
  await stage(path.join(target, "second"), []);
  await assert.rejects(fs.access(path.join(target, "second/video-footage/sources/selected.mp4")));
  assert.equal(await fs.readFile(path.join(target, "second/logo.svg"), "utf8"), "logo");
  assert.equal(copies, 1);
  await assert.rejects(stage(path.join(target, "bad"), ["../escape.mp4"]));
});
