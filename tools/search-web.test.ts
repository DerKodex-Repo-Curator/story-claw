import assert from "node:assert/strict";
import test from "node:test";
import {classifySource} from "./search-web";

test("web search ranks first-party and mainstream outlets above unverified sources", () => {
  assert.equal(classifySource("https://openai.com/index/official-update").sourceQuality, "official");
  assert.equal(classifySource("https://www.reuters.com/technology/story").sourceQuality, "major-media");
  assert.equal(classifySource("https://www.news.cn/tech/story").sourceQuality, "major-media");
  assert.equal(classifySource("https://www.chinanews.com.cn/tech/story").sourceQuality, "major-media");
  assert.equal(classifySource("https://www.jiemian.com/article/story").sourceQuality, "major-media");
  assert.equal(classifySource("https://www.bbc.co.uk/news/story").sourceQuality, "major-media");
  assert.equal(classifySource("https://www.mit.edu/research/story").sourceQuality, "research");
  assert.equal(classifySource("https://x.com/official/status/123").sourceQuality, "x-related");
});

test("web search excludes personal platforms, aggregators and local URLs", () => {
  for (const url of [
    "https://weibo.com/123/post",
    "https://author.medium.com/story",
    "https://writer.substack.com/p/story",
    "https://news.google.com/read/example",
    "https://mp.weixin.qq.com/s/story",
    "https://blog.csdn.net/author/article/details/123",
    "https://x.com/random_account",
    "https://www.bing.com/search?q=story",
    "http://localhost:8080/article",
    "http://127.0.0.1/article",
  ]) {
    assert.equal(classifySource(url).sourceQuality, "excluded", url);
  }
  assert.equal(classifySource("https://openai.com.evil.example/story").sourceQuality, "other");
  assert.equal(classifySource("https://github.com/random-user/post").sourceQuality, "other");
});
