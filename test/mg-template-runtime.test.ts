import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {loadMgTemplateProvider} from "../utils/mg-template-runtime.js";

test("template loader rejects old manifests and providers before webpage capture", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-provider-test-"));
  const previous = process.env.STORY_CLAW_MG_TEMPLATES_DIR;
  process.env.STORY_CLAW_MG_TEMPLATES_DIR = directory;
  try {
    await fs.writeFile(path.join(directory, "provider.mjs"), "export const getMgTemplateProvider = () => ({protocolVersion: 2});");
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({protocolVersion: 2, provider: "provider.mjs"}));
    await assert.rejects(loadMgTemplateProvider, /主程序需要 v4.*当前为 v2/);
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({protocolVersion: 4, provider: "provider.mjs"}));
    await assert.rejects(loadMgTemplateProvider, /Provider.*主程序需要 v4.*当前为 v2/);
  } finally {
    if (previous === undefined) delete process.env.STORY_CLAW_MG_TEMPLATES_DIR;
    else process.env.STORY_CLAW_MG_TEMPLATES_DIR = previous;
    await fs.rm(directory, {recursive: true, force: true});
  }
});
