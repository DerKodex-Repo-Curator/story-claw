import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, {after} from "node:test";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-claw-search-test-"));
const previousWorkDir = process.env.STORY_CLAW_WORK_DIR;
process.env.STORY_CLAW_WORK_DIR = directory;
const {buildWebSnapshot, extractReadablePage, searchWebTool} = await import("../tools/search-web.js");
const {readWebSnapshot, resolveWebSnapshot, saveWebSnapshot, webSnapshotPathForUrl} = await import("../tools/web-snapshot.js");
const {buildTranslationBatches} = await import("../tools/web-translation.js");
after(async () => {
  if (previousWorkDir === undefined) delete process.env.STORY_CLAW_WORK_DIR;
  else process.env.STORY_CLAW_WORK_DIR = previousWorkDir;
  await fs.rm(directory, {recursive: true, force: true});
});

const articleHtml = `<!doctype html><html><head>
  <title>原网页标题</title><meta property="og:title" content="网页原始报道">
  </head><body><nav>不要摘导航里的词语</nav><main><article>
  <h1>TypeSafe AI 发布 Jev</h1>
  <p>Jev <span>不生成文本</span>，而是处理另一类任务。</p>
  <p>模型的能力涉及代码分析、长任务规划以及金融数据处理。</p>
  <aside>不要摘相关推荐里的词语</aside>
  <p style="display:none">不要摘隐藏的词语</p>
  </article></main><script>不要摘脚本里的词语</script></body></html>`;

const resultText = (result: Awaited<ReturnType<typeof searchWebTool.execute>>): string => {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("search_web did not return text");
  return block.text;
};

test("search_web extracts selected article text, not page chrome or hidden content", () => {
  const page = extractReadablePage(articleHtml);
  assert.equal(page.title, "网页原始报道");
  assert.equal(page.source, "article");
  assert.match(page.content, /Jev 不生成文本/);
  assert.doesNotMatch(page.content, /不要摘/);
  assert.equal(page.truncated, false);
});

test("search_web URL mode returns the selected page body after a redirect", async () => {
  const previousFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://example.org/old") {
      return new Response(null, {status: 302, headers: {location: "/story"}});
    }
    assert.equal(url, "https://example.org/story");
    return new Response(articleHtml, {headers: {"content-type": "text/html; charset=utf-8"}});
  }) as typeof fetch;
  try {
    const result = await searchWebTool.execute("read-page", {url: "https://example.org/old"}, undefined, undefined, {} as never);
    assert.deepEqual(requested, ["https://example.org/old", "https://example.org/story"]);
    const output = resultText(result);
    assert.equal(output, extractReadablePage(articleHtml).content);
    assert.equal(result.details, undefined);
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(result))), ["content"]);
    assert.match(output, /Jev 不生成文本/);
    assert.doesNotMatch(output, /它不生成聊天文本/);
    assert.equal(await resolveWebSnapshot("https://example.org/old"), webSnapshotPathForUrl("https://example.org/old"));
    assert.equal(await resolveWebSnapshot("https://example.org/story"), webSnapshotPathForUrl("https://example.org/story"));
    assert.equal(extractReadablePage((await readWebSnapshot("https://example.org/story"))!).content, output);
    // Subsequent URL reads (including fragments and redirect aliases) must not refetch or retranslate.
    for (const url of ["https://example.org/old#section", "https://example.org/story"]) {
      const repeated = await searchWebTool.execute("reread-page", {url}, undefined, undefined, {} as never);
      assert.equal(resultText(repeated), output);
    }
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    await Promise.all([
      fs.rm(webSnapshotPathForUrl("https://example.org/old"), {force: true}),
      fs.rm(webSnapshotPathForUrl("https://example.org/story"), {force: true}),
    ]);
  }
});

test("Chinese pages bypass translation and keep inline markup and relative assets", async () => {
  const snapshot = await buildWebSnapshot(articleHtml, "https://example.org/story", extractReadablePage(articleHtml).content, async () => {
    assert.fail("Chinese body must not be translated");
  });
  assert.equal(snapshot.content, extractReadablePage(articleHtml).content);
  assert.match(snapshot.html, /<span>不生成文本<\/span>/);
  assert.match(snapshot.html, /<base href="https:\/\/example.org\/story">/);
  assert.match(snapshot.html, /<meta charset="utf-8">/);
});

test("English body is replaced in the saved DOM even when the original page contains a little Chinese", async () => {
  const html = '<html><head><meta charset="windows-1252"><title>Example title</title></head><body><nav>中文帮助</nav><article><p>This document describes the overall architecture of HTTP, and introduces the terminology used throughout the specification.</p></article></body></html>';
  const chinese = "本文介绍了超文本传输协议的整体架构，并且详细说明了本规范中使用的术语以及它们之间的关系，便于读者理解协议。";
  const snapshot = await buildWebSnapshot(html, "https://example.org/english", extractReadablePage(html).content, async (texts) => {
    assert.ok(texts.some(({text}) => text.startsWith("This document")));
    return texts.map(({id, text}) => `<span data-sc-id="${id}">${text.startsWith("This document") ? chinese : "示例标题"}</span>`);
  });
  assert.equal(snapshot.content, chinese);
  assert.ok(snapshot.html.includes(chinese));
  assert.doesNotMatch(snapshot.html, /This document describes|windows-1252/);
  await assert.rejects(() => buildWebSnapshot(html, "https://example.org/english", extractReadablePage(html).content,
    async (texts) => texts.map(({id, text}) => `<span data-sc-id="${id}">${text}</span>`)), /未成功翻译成中文/);
  await assert.rejects(() => buildWebSnapshot(html, "https://example.org/english", extractReadablePage(html).content,
    async () => ['<span data-sc-id="900">错误节点</span>']), /翻译结果不完整/);
});

test("translated article remains the selected body after shrinking, with active site content frozen", async () => {
  const english = "The laboratory published the full research report, including technical details, measured results and independent evaluations. ".repeat(3);
  const html = `<html><head><meta http-equiv="refresh" content="0;url=https://example.org/new"></head><body>
    <article><p>${"Secondary article that must not replace the selected report. ".repeat(3)}</p></article>
    <article><p onmouseover="this.textContent='changed'">${english}</p><img src="/figure.png"></article>
    <script>document.querySelector('article').textContent = 'changed';</script></body></html>`;
  const translated = "实验室公布了完整研究报告，详细介绍技术方法和实际测量结果，并包含独立评估，读者可以据此了解实验的具体过程。";
  const snapshot = await buildWebSnapshot(html, "https://example.org/report", english, async (texts) => {
    assert.equal(texts.length, 1);
    assert.equal(texts[0].text, english);
    return [`<span data-sc-id="0">${translated}</span>`];
  });
  assert.equal(snapshot.content, translated);
  assert.equal(extractReadablePage(snapshot.html).content, translated);
  assert.match(snapshot.html, /<img src="\/figure.png">/);
  assert.doesNotMatch(snapshot.html, /<script|onmouseover|http-equiv="refresh"/);
});

test("simultaneous URL reads share one saved page, including fragment aliases", async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async () => {
    reads++;
    return new Response(articleHtml, {headers: {"content-type": "text/html"}});
  }) as typeof fetch;
  try {
    const results = await Promise.all(["", "#first", "#second"].map((fragment) =>
      searchWebTool.execute("parallel", {url: `https://example.org/parallel${fragment}`}, undefined, undefined, {} as never)));
    assert.equal(reads, 1);
    assert.ok(results.every((result) => resultText(result) === extractReadablePage(articleHtml).content));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent redirect aliases use the same canonical snapshot", async () => {
  const originalFetch = globalThis.fetch;
  let revision = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/alias-a") || url.endsWith("/alias-b")) {
      return new Response(null, {status: 302, headers: {location: "/shared-report"}});
    }
    return new Response(articleHtml.replace("发布 Jev", `发布 Jev ${++revision}`), {headers: {"content-type": "text/html"}});
  }) as typeof fetch;
  try {
    const urls = ["https://example.org/alias-a", "https://example.org/alias-b", "https://example.org/shared-report"];
    const results = await Promise.all(urls.map((url) => searchWebTool.execute("aliases", {url}, undefined, undefined, {} as never)));
    assert.equal(new Set(results.map(resultText)).size, 1);
    assert.equal(new Set(await Promise.all(urls.map(readWebSnapshot))).size, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("long paragraphs are translated in bounded batches without dropping characters", () => {
  const source = "This paragraph has <inline> text & symbols. ".repeat(60);
  const batches = buildTranslationBatches([{id: 0, text: source}]);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length <= 850));
  assert.equal(extractReadablePage(`<body><p>${batches.join("")}</p></body>`).content, source.trim());
});

test("saving an existing snapshot preserves the first complete page", async () => {
  const url = "https://example.org/persist-once";
  await saveWebSnapshot([url], articleHtml);
  await Promise.all(Array.from({length: 4}, (_, index) =>
    saveWebSnapshot([`${url}#${index}`], articleHtml.replace("不生成文本", "不应替换首次译文"))));
  assert.equal(await readWebSnapshot(url), articleHtml);
  const entries = await fs.readdir(path.dirname(webSnapshotPathForUrl(url)));
  assert.ok(entries.every((entry) => !entry.endsWith(".next")), "temporary publication files must be cleaned up");
});

test("search_web retains query mode and requires exactly one of query or url", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).startsWith("https://html.duckduckgo.com/")) {
      return new Response(`<div class="result"><a class="result__a" href="https://example.org/story">报道</a>
        <a class="result__snippet">搜索摘要</a></div></body>`, {status: 200});
    }
    assert.equal(String(input), "https://example.org/story");
    return new Response(articleHtml, {headers: {"content-type": "text/html"}});
  }) as typeof fetch;
  try {
    const result = await searchWebTool.execute("search", {query: "Jev"}, undefined, undefined, {} as never);
    const output = JSON.parse(resultText(result)) as {query: string; results: Array<{url: string; snippet: string; content?: string}>};
    assert.equal(output.query, "Jev");
    assert.equal(output.results[0].url, "https://example.org/story");
    assert.equal(output.results[0].snippet, "搜索摘要");
    assert.equal(output.results[0].content, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
  const invalid = await searchWebTool.execute("invalid", {query: "Jev", url: "https://example.org/story"}, undefined, undefined, {} as never);
  assert.match(resultText(invalid), /ERROR: query 和 url 必须二选一/);
  const local = await searchWebTool.execute("local", {url: "http://127.0.0.1/private"}, undefined, undefined, {} as never);
  assert.match(resultText(local), /ERROR:.*本地地址/);
});

test("search_web rejects a blocked or JavaScript-only page instead of presenting a snippet as source text", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html><body><div id='app'></div></body></html>", {
    headers: {"content-type": "text/html"},
  })) as typeof fetch;
  try {
    const result = await searchWebTool.execute("empty-page", {url: "https://example.org/story"}, undefined, undefined, {} as never);
    assert.match(resultText(result), /ERROR: 网页没有足够的可读取正文/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
