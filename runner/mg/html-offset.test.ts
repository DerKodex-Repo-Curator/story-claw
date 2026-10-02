import assert from "node:assert/strict";
import test from "node:test";
import type {ArticleTimelineEntry} from "../render.js";
import {locateMgInstances} from "./html.js";

test("MG anchors retain spaces across nested HTML text nodes", () => {
  const source = "引言。\n\n第一条新闻 正文 重点。\n\n第二条新闻 正文 结尾。";
  const html = `<!DOCTYPE html><html><body><article> \n`
    + `<ai-hot-focus-stage group="focus-stage" mode="together" values='["第一条新闻","第二条新闻"]'>`
    + `引言。\n\n<mg-value value="1">第一条新闻</mg-value> 正文 `
    + `<emphasis group="scale" mode="together">重点</emphasis>。\n\n`
    + `<mg-value value="2">第二条新闻</mg-value> 正文 结尾。`
    + `</ai-hot-focus-stage>\n </article></body></html>`;
  const plain = source.replace(/\n/g, "");
  const timeline: ArticleTimelineEntry[] = [...plain].map((char, index) => ({
    index,
    char,
    group_order: 0,
    start: index / 10,
    end: (index + 1) / 10,
  }));
  const instances = locateMgInstances(html, timeline, source);
  const stage = instances.get("ai-hot-focus-stage::focus-stage::one")!;
  const emphasis = instances.get("emphasis::scale::one")!;

  assert.equal(stage.tags[0].start, 0);
  assert.deepEqual(
    stage.tags[0].valueAnchors?.map((anchor) => anchor.start),
    ["第一条新闻", "第二条新闻"].map((title) => plain.indexOf(title) / 10),
  );
  assert.equal(emphasis.tags[0].start, plain.indexOf("重点") / 10);
});
