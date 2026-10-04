import {createRequire} from "node:module";
import net from "node:net";
import {Type} from "@sinclair/typebox";
import type {ToolDefinition} from "@mariozechner/pi-coding-agent";
import {EnvHttpProxyAgent} from "undici";
import {translateWebText} from "./web-translation.js";
import {readWebSnapshot, saveWebSnapshot, webSnapshotPathForUrl} from "./web-snapshot.js";

const require = createRequire(import.meta.url);
const parse5 = require("parse5") as {parse(input: string): HtmlNode; serialize(input: HtmlNode): string; parseFragment(input: string): HtmlNode};

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{name: string; value: string}>;
  childNodes?: HtmlNode[];
  namespaceURI?: string;
};

const MAX_PAGE_HTML_BYTES = 4_000_000;
const MAX_PAGE_TEXT_CHARS = 20_000;
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "nav", "footer", "aside"]);
const TEXT_BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "p", "li", "blockquote"]);

// Node's native fetch does not consistently honor HTTP(S)_PROXY.  The image
// selection step often runs through the same local proxy as the image API, so
// use one shared dispatcher for both search and metadata requests.
const fetchDispatcher = new EnvHttpProxyAgent();
const fetchWithProxy = (input: string | URL, init: RequestInit = {}) =>
  fetch(input, {...init, dispatcher: fetchDispatcher} as RequestInit);

type SearchHit = {
  title: string;
  url: string;
  snippet?: string;
  imageUrl?: string;
  screenshotUrl: string;
  sourceQuality: SourceQuality;
  sourceReason: string;
};

type SourceQuality = "official" | "major-media" | "research" | "x-related" | "other" | "excluded";

const MAJOR_MEDIA_HOSTS = new Set([
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "techcrunch.com",
  "theverge.com",
  "arstechnica.com",
  "technologyreview.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "nytimes.com",
  "washingtonpost.com",
  "theguardian.com",
  "cnbc.com",
  "wired.com",
  "axios.com",
  "scmp.com",
  "nikkei.com",
  "news.cn",
  "xinhuanet.com",
  "people.com.cn",
  "cctv.com",
  "cnr.cn",
  "gmw.cn",
  "chinanews.com.cn",
  "caixin.com",
  "yicai.com",
  "stcn.com",
  "thepaper.cn",
  "jiemian.com",
  "36kr.com",
]);

// Known first-party company/newsroom/documentation domains.  Keep this list
// explicit so a random blog or repost host cannot be promoted to `official`
// merely because its hostname contains words such as "blog" or "news".
const OFFICIAL_HOSTS = new Set([
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "ai.google",
  "research.google",
  "blog.google",
  "googleblog.com",
  "cloud.google.com",
  "microsoft.com",
  "blogs.microsoft.com",
  "azure.microsoft.com",
  "github.blog",
  "docs.github.com",
  "meta.com",
  "about.fb.com",
  "ai.meta.com",
  "apple.com",
  "developer.apple.com",
  "nvidia.com",
  "developer.nvidia.com",
  "blogs.nvidia.com",
  "aws.amazon.com",
  "ibm.com",
  "intel.com",
  "x.ai",
  "mistral.ai",
  "cohere.com",
  "databricks.com",
  "stability.ai",
  "adobe.com",
  "salesforce.com",
  "oracle.com",
  "ir.baidu.com",
  "aliyun.com",
  "alibabagroup.com",
  "tencent.com",
  "deepseek.com",
  "zhipuai.cn",
  "moonshot.cn",
  "stepfun.com",
  "minimax.io",
]);

const EXCLUDED_HOST_PATTERNS = [
  /(?:^|\.)weibo\.com$/i,
  /(?:^|\.)medium\.com$/i,
  /(?:^|\.)substack\.com$/i,
  /(?:^|\.)blogspot\.[a-z.]+$/i,
  /(?:^|\.)wordpress\.[a-z.]+$/i,
  /(?:^|\.)zhihu\.com$/i,
  /(?:^|\.)baijiahao\.baidu\.com$/i,
  /(?:^|\.)mp\.weixin\.qq\.com$/i,
  /(?:^|\.)blog\.sina\.com\.cn$/i,
  /(?:^|\.)blog\.csdn\.net$/i,
  /(?:^|\.)toutiao\.com$/i,
  /(?:^|\.)reddit\.com$/i,
  /(?:^|\.)quora\.com$/i,
  /(?:^|\.)juejin\.cn$/i,
  /(?:^|\.)bilibili\.com$/i,
  /(?:^|\.)feedly\.com$/i,
  /(?:^|\.)ground\.news$/i,
  /^news\.google\.com$/i,
  /(?:^|\.)bing\.com$/i,
  /(?:^|\.)duckduckgo\.com$/i,
];

const hostnameFor = (value: string): string => {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
};

const isResearchHost = (hostname: string): boolean =>
  hostname.endsWith(".edu") || hostname.endsWith(".edu.cn") || hostname.endsWith(".ac.uk")
  || hostname.endsWith(".ac.cn") || hostname.endsWith(".gov") || hostname.endsWith(".gov.cn");

const isOfficialHost = (hostname: string): boolean =>
  [...OFFICIAL_HOSTS].some((host) => hostname === host || hostname.endsWith(`.${host}`));

export const classifySource = (value: string): {sourceQuality: SourceQuality; sourceReason: string} => {
  const hostname = hostnameFor(value);
  if (!hostname) return {sourceQuality: "excluded", sourceReason: "invalid URL hostname"};
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || net.isIP(hostname)) {
    return {sourceQuality: "excluded", sourceReason: "非公开网页地址"};
  }
  if (EXCLUDED_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return {sourceQuality: "excluded", sourceReason: "个人博客、社交平台或转载聚合域名"};
  }
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "twitter.com" || hostname.endsWith(".twitter.com")) {
    const pathname = new URL(value).pathname;
    if (!/^\/[A-Za-z0-9_]+\/status\/\d+(?:\/|$)/.test(pathname)) {
      return {sourceQuality: "excluded", sourceReason: "X/Twitter 链接不是原帖"};
    }
    return {sourceQuality: "x-related", sourceReason: "X/Twitter；仅允许事件直接相关的官方账号、高管、研究者、当事人或现场参与者"};
  }
  if (MAJOR_MEDIA_HOSTS.has(hostname) || [...MAJOR_MEDIA_HOSTS].some((host) => hostname.endsWith(`.${host}`))) {
    return {sourceQuality: "major-media", sourceReason: "主流新闻媒体"};
  }
  if (isOfficialHost(hostname)) return {sourceQuality: "official", sourceReason: "公司官方公告、技术博客、产品文档或研究页面"};
  if (isResearchHost(hostname)) return {sourceQuality: "research", sourceReason: "政府、教育或研究机构域名"};
  return {sourceQuality: "other", sourceReason: "未能从域名自动确认官方属性，需由规划模型核验"};
};

const assertReadableSource = (value: string): void => {
  const classification = classifySource(value);
  if (classification.sourceQuality === "excluded") {
    throw new Error(`来源域名不符合质量要求：${classification.sourceReason}`);
  }
};

const decodeHtml = (value: string): string => value
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const decodeUrl = (value: string): string => {
  const raw = decodeHtml(value);
  const match = raw.match(/[?&]uddg=([^&]+)/i);
  try { return decodeURIComponent(match?.[1] ?? raw); } catch { return raw; }
};

const attr = (html: string, name: string): string | undefined => {
  const match = html.match(new RegExp(`<meta\\b[^>]*\\b(?:property|name)=["']${name}["'][^>]*\\bcontent=["']([^"']+)["'][^>]*>`, "i"))
    ?? html.match(new RegExp(`<meta\\b[^>]*\\bcontent=["']([^"']+)["'][^>]*\\b(?:property|name)=["']${name}["'][^>]*>`, "i"));
  return match?.[1] ? decodeHtml(match[1]) : undefined;
};

const screenshotUrlFor = (url: string): string => `https://image.thum.io/get/width/1280/crop/900/noanimate/${url}`;

const nodeAttr = (node: HtmlNode, name: string): string | undefined =>
  node.attrs?.find((item) => item.name === name)?.value;

const isHiddenNode = (node: HtmlNode): boolean =>
  Boolean(node.tagName && (
    SKIP_TAGS.has(node.tagName)
    || nodeAttr(node, "hidden") !== undefined
    || nodeAttr(node, "aria-hidden") === "true"
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(nodeAttr(node, "style") ?? "")
  ));

const nodeText = (node: HtmlNode): string => {
  if (isHiddenNode(node)) return "";
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(nodeText).join("");
};

const textBlocks = (root: HtmlNode): string[] => {
  const blocks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (isHiddenNode(node)) return;
    if (node.tagName && TEXT_BLOCK_TAGS.has(node.tagName)) {
      const text = nodeText(node).trim();
      if (text) blocks.push(text);
      return;
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return blocks;
};

/** Preserve the source text inside each block, so a short phrase can be copied verbatim. */
export const extractReadablePage = (html: string): {title: string; content: string; totalCharacters: number; truncated: boolean; source: string} => {
  const {document, selected, source} = findReadableSelection(html);
  const blocks = textBlocks(selected);
  const fullText = blocks.length ? blocks.join("\n\n") : nodeText(selected).trim();
  if (fullText.trim().length < 40) throw new Error("网页没有足够的可读取正文；可能需要 JavaScript 或被网站拦截，请换一篇报道");
  const titleNode = ((): HtmlNode | undefined => {
    const find = (node: HtmlNode): HtmlNode | undefined =>
      node.tagName === "title" ? node : (node.childNodes ?? []).map(find).find(Boolean);
    return find(document);
  })();
  return {
    title: attr(html, "og:title") ?? (titleNode ? nodeText(titleNode).trim() : ""),
    content: fullText.slice(0, MAX_PAGE_TEXT_CHARS),
    totalCharacters: fullText.length,
    truncated: fullText.length > MAX_PAGE_TEXT_CHARS,
    source,
  };
};

const pageUrl = (value: string): string => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("url 必须是有效的 http(s) 网页地址"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
    || !hostname || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || net.isIP(hostname) !== 0) {
    throw new Error("url 必须是公开的 http(s) 网页地址，不能是本地地址或 IP 地址");
  }
  return url.href;
};

const responseHtml = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("网页响应没有正文");
  const decoder = new TextDecoder();
  let html = "";
  let size = 0;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_HTML_BYTES) {
      await reader.cancel();
      throw new Error("网页正文过大，无法完整读取");
    }
    html += decoder.decode(value, {stream: true});
  }
  return html + decoder.decode();
};

const readWebPage = async (inputUrl: string) => {
  let url = pageUrl(inputUrl);
  assertReadableSource(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchWithProxy(url, {
      headers: {"user-agent": "StoryClaw/1.0 web-search"},
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`网页跳转缺少目标地址: ${url}`);
      url = pageUrl(new URL(location, url).href);
      assertReadableSource(url);
      continue;
    }
    if (!response.ok) throw new Error(`网页读取失败: HTTP ${response.status}`);
    if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("content-type") ?? "")) {
      throw new Error("该 URL 没有返回 HTML 网页，请换用报道原文地址");
    }
    const html = await responseHtml(response);
    const page = extractReadablePage(html);
    return {url, html, ...page};
  }
  throw new Error("网页跳转次数过多");
};

type ReadableSelection = {
  document: HtmlNode;
  selected: HtmlNode;
  source: string;
};

const findReadableSelection = (html: string): ReadableSelection => {
  const document = parse5.parse(html);
  const candidates: Array<{node: HtmlNode; source: string}> = [];
  const visit = (node: HtmlNode): void => {
    if (isHiddenNode(node)) return;
    if (node.tagName === "article") candidates.push({node, source: "article"});
    else if (nodeAttr(node, "role") === "main" || node.tagName === "main") candidates.push({node, source: "main"});
    else if (node.tagName === "body") candidates.push({node, source: "body"});
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  const ranked = candidates
    .map(({node, source}) => ({node, source, blocks: textBlocks(node)}))
    .sort((left, right) => {
      const priority = (source: string): number => source === "article" ? 2 : source === "main" ? 1 : 0;
      return priority(right.source) - priority(left.source) || right.blocks.join("").length - left.blocks.join("").length;
    });
  const selected = ranked.find((item) => item.blocks.join("").trim().length >= 80) ?? ranked[0];
  if (!selected) throw new Error("网页没有可读取的正文");
  // Translation changes paragraph lengths; retain the originally selected article.
  const saved = ranked.find(({node}) => nodeAttr(node, "data-sc-web-content") !== undefined);
  return {document, selected: (saved ?? selected).node, source: (saved ?? selected).source};
};

const plainNodeText = (node: HtmlNode): string =>
  node.nodeName === "#text" ? node.value ?? "" : (node.childNodes ?? []).map(plainNodeText).join("");

const translatableTextNodes = (root: HtmlNode): HtmlNode[] => {
  const nodes: HtmlNode[] = [];
  const visit = (node: HtmlNode, blocked: boolean): void => {
    const hidden = blocked || isHiddenNode(node);
    if (hidden) return;
    if (node.nodeName === "#text") {
      if ((node.value ?? "").trim()) nodes.push(node);
      return;
    }
    for (const child of node.childNodes ?? []) visit(child, hidden);
  };
  visit(root, false);
  return nodes;
};

const titleTextNodes = (document: HtmlNode): HtmlNode[] => {
  let title: HtmlNode | undefined;
  const visit = (node: HtmlNode): void => {
    if (title || isHiddenNode(node)) return;
    if (node.tagName === "title") {
      title = node;
      return;
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  return title ? translatableTextNodes(title) : [];
};

const translationMap = (batches: readonly string[]): Map<number, string> => {
  const translated = new Map<number, string>();
  const visit = (node: HtmlNode): void => {
    const id = nodeAttr(node, "data-sc-id");
    if (id !== undefined && /^-?\d+$/.test(id)) {
      translated.set(Number(id), (translated.get(Number(id)) ?? "") + plainNodeText(node));
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  for (const batch of batches) visit(parse5.parseFragment(batch));
  return translated;
};

const setBaseHref = (document: HtmlNode, url: string): void => {
  let head: HtmlNode | undefined;
  const visit = (node: HtmlNode): void => {
    if (head) return;
    if (node.tagName === "head") { head = node; return; }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  if (!head) return;
  // Snapshots are always written as UTF-8, regardless of the site's original encoding.
  head.childNodes = (head.childNodes ?? []).filter((node) => node.tagName !== "meta"
    || (nodeAttr(node, "charset") === undefined && nodeAttr(node, "http-equiv")?.toLowerCase() !== "content-type"));
  head.childNodes.unshift({nodeName: "meta", tagName: "meta", namespaceURI: "http://www.w3.org/1999/xhtml", attrs: [{name: "charset", value: "utf-8"}], childNodes: []});
  const existingBase = head.childNodes.find((node) => node.tagName === "base");
  const baseHref = new URL(nodeAttr(existingBase ?? {}, "href") ?? url, url).href;
  head.childNodes = head.childNodes.filter((node) => node.tagName !== "base");
  head.childNodes.splice(1, 0, {nodeName: "base", tagName: "base", namespaceURI: "http://www.w3.org/1999/xhtml", attrs: [{name: "href", value: baseHref}], childNodes: []});
};

const freezeSnapshot = (node: HtmlNode): void => {
  // Keep markup, styles and images, but never let the original site replace the saved text.
  node.childNodes = node.childNodes?.filter((child) => child.tagName !== "script"
    && !(child.tagName === "meta" && nodeAttr(child, "http-equiv")?.toLowerCase() === "refresh"));
  node.attrs = node.attrs?.filter(({name}) => !name.startsWith("on") && name !== "data-sc-web-content");
  for (const child of node.childNodes ?? []) freezeSnapshot(child);
};

const predominantlyChinese = (value: string): boolean => {
  const han = (value.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  const other = (value.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}]/gu) ?? []).length;
  return han >= 24 && han >= latin * 0.5 && han >= other * 2;
};

/** Build the one browser snapshot consumed by the later MG capture stage. */
export const buildWebSnapshot = async (
  html: string,
  finalUrl: string,
  pageContent: string,
  translate = translateWebText,
): Promise<{html: string; content: string}> => {
  const selection = findReadableSelection(html);
  const nodes = [...translatableTextNodes(selection.selected), ...titleTextNodes(selection.document)];
  const needsTranslation = !predominantlyChinese(pageContent) && nodes.length > 0;
  if (needsTranslation) {
    const batches = await translate(nodes.map((node, id) => ({id, text: node.value ?? ""})));
    const values = translationMap(batches);
    if (values.size !== nodes.length || nodes.some((_, id) => !values.get(id)?.trim())) {
      throw new Error("网页翻译结果不完整，无法保存快照");
    }
    nodes.forEach((node, id) => { node.value = values.get(id)!; });
  }
  freezeSnapshot(selection.document);
  (selection.selected.attrs ??= []).push({name: "data-sc-web-content", value: ""});
  setBaseHref(selection.document, finalUrl);
  const snapshotHtml = parse5.serialize(selection.document);
  const content = extractReadablePage(snapshotHtml).content;
  if (needsTranslation && !predominantlyChinese(content)) {
    throw new Error("网页正文未成功翻译成中文，无法保存快照");
  }
  return {html: snapshotHtml, content};
};

// Concurrent reads of the same URL must also reuse the first translation.
const pendingPageReads = new Map<string, Promise<string>>();

const sharePageRead = (url: string, work: () => Promise<string>): Promise<string> => {
  const key = webSnapshotPathForUrl(url);
  const pending = pendingPageReads.get(key);
  if (pending) return pending;
  const read = work();
  pendingPageReads.set(key, read);
  void read.finally(() => pendingPageReads.delete(key)).catch(() => undefined);
  return read;
};

const readFinalPageContent = (inputUrl: string): Promise<string> => {
  const url = pageUrl(inputUrl);
  assertReadableSource(url);
  return sharePageRead(url, async () => {
    const saved = await readWebSnapshot(url);
    if (saved) return extractReadablePage(saved).content;
    const page = await readWebPage(url);
    const prepare = async (): Promise<string> => {
      const existing = await readWebSnapshot(page.url);
      if (existing) return extractReadablePage(existing).content;
      const snapshot = await buildWebSnapshot(page.html, page.url, page.content);
      await saveWebSnapshot([page.url], snapshot.html);
      // Another process may have saved this URL first; return the version capture will use.
      const persisted = await readWebSnapshot(page.url);
      if (!persisted) throw new Error("网页快照保存失败");
      return extractReadablePage(persisted).content;
    };
    if (webSnapshotPathForUrl(url) === webSnapshotPathForUrl(page.url)) return prepare();
    // Redirect aliases share the canonical URL's first translation as well.
    const content = await sharePageRead(page.url, prepare);
    const snapshot = await readWebSnapshot(page.url);
    if (!snapshot) throw new Error("网页快照保存失败");
    await saveWebSnapshot([url], snapshot);
    return content;
  });
};

const searchDuckDuckGo = async (query: string, maxResults: number): Promise<Array<{title: string; url: string; snippet?: string}>> => {
  const response = await fetchWithProxy(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {"user-agent": "StoryClaw/1.0 web-search"},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`web search failed: ${response.status}`);
  const html = await response.text();
  const hits: Array<{title: string; url: string; snippet?: string}> = [];
  const blockPattern = /<div[^>]+class=["'][^"']*result[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]+class=["'][^"']*result[^"']|<\/body>)/gi;
  for (const block of html.matchAll(blockPattern)) {
    const body = block[1];
    const link = body.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeUrl(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeHtml(link[2].replace(/<[^>]+>/g, "").trim());
    const snippet = body.match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? body.match(/<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    hits.push({title, url, snippet: snippet ? decodeHtml(snippet.replace(/<[^>]+>/g, "").trim()) : undefined});
    if (hits.length >= maxResults) break;
  }
  return hits;
};

const enrichHit = async (hit: {title: string; url: string; snippet?: string}): Promise<SearchHit> => {
  const source = classifySource(hit.url);
  let title = hit.title;
  let imageUrl: string | undefined;
  try {
    const response = await fetchWithProxy(hit.url, {
      headers: {"user-agent": "StoryClaw/1.0 web-search"},
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok && /^text\/html/i.test(response.headers.get("content-type") ?? "")) {
      const html = await response.text();
      title = attr(html, "og:title") ?? title;
      imageUrl = attr(html, "og:image") ?? attr(html, "twitter:image");
    }
  } catch {
    // Search results remain useful when an article blocks metadata fetching.
  }
  return {title, url: hit.url, snippet: hit.snippet, ...(imageUrl ? {imageUrl} : {}), screenshotUrl: screenshotUrlFor(hit.url), ...source};
};

const sourceRank = (quality: SourceQuality): number => ({official: 0, "major-media": 1, research: 2, "x-related": 3, other: 4, excluded: 9}[quality]);

export const searchWebTool: ToolDefinition = {
  name: "search_web",
  label: "搜索或读取网页素材",
  description: "传 query 搜索真实网页，返回候选来源；选择报道后再传 url 读取那一页的最终网页正文（非中文网页会先翻译并保存同一份浏览器快照）。query 和 url 只能填写一个；无法读取正文时不要将搜索摘要冒充网页原文。仅在当前模板提示词要求网络素材时调用。",
  parameters: Type.Object({
    query: Type.Optional(Type.String({description: "搜索关键词；与 url 二选一。优先包含当前动画文字和主题上下文"})),
    url: Type.Optional(Type.String({description: "已选中的报道原文 URL；与 query 二选一，用于读取网页正文"})),
    maxResults: Type.Optional(Type.Number({description: "最多返回几条结果，默认 6，范围 2-10"})),
  }),
  execute: async (_toolCallId: string, args: {query?: string; url?: string; maxResults?: number}) => {
    const query = args.query?.trim();
    const url = args.url?.trim();
    if (Boolean(query) === Boolean(url)) {
      return {content: [{type: "text" as const, text: "ERROR: query 和 url 必须二选一"}], details: undefined};
    }
    try {
      if (url) {
        return {
          content: [{type: "text" as const, text: await readFinalPageContent(url)}],
          details: undefined,
        };
      }
      const maxResults = Math.min(10, Math.max(2, Math.trunc(args.maxResults ?? 6)));
      const searchQuery = query!;
      const raw = await searchDuckDuckGo(searchQuery, maxResults * 4);
      const eligible = raw.filter((hit) => classifySource(hit.url).sourceQuality !== "excluded")
        .sort((left, right) => sourceRank(classifySource(left.url).sourceQuality) - sourceRank(classifySource(right.url).sourceQuality));
      const hits = await Promise.all(eligible.slice(0, maxResults).map(enrichHit));
      return {
        content: [{type: "text" as const, text: JSON.stringify({query: searchQuery, results: hits}, null, 2)}],
        details: {query: searchQuery, count: hits.length},
      };
    } catch (error) {
      return {content: [{type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}`}], details: undefined};
    }
  },
};
