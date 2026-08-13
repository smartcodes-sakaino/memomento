import { describe, it, expect } from "vitest";
import { extractLinkedPageIds, normalizeExternalUrl, syncLinkLabels } from "@/lib/wikilink";

describe("extractLinkedPageIds", () => {
  it("HTML内のdata-page-idを全て抽出する", () => {
    const html =
      '参加者: <a class="wikilink" data-page-id="p_1">田中さん</a> と ' +
      '<a class="wikilink" data-page-id="p_2">鈴木さん</a>';
    expect(extractLinkedPageIds(html)).toEqual(["p_1", "p_2"]);
  });

  it("リンクがない場合は空配列", () => {
    expect(extractLinkedPageIds("ただのテキスト")).toEqual([]);
  });
});

describe("syncLinkLabels(ページ名変更への追従)", () => {
  it("リンクの表示テキストが最新のページ名に置き換わる", () => {
    const html = '<a class="wikilink" data-page-id="p_1">旧タイトル</a>';
    const titles = new Map([["p_1", "新タイトル"]]);
    expect(syncLinkLabels(html, titles)).toBe(
      '<a class="wikilink" data-page-id="p_1">新タイトル</a>'
    );
  });

  it("タイトルにHTML特殊文字が含まれてもエスケープされる(XSS対策)", () => {
    const html = '<a class="wikilink" data-page-id="p_1">旧</a>';
    const titles = new Map([["p_1", '<script>alert("x")</script>']]);
    const result = syncLinkLabels(html, titles);
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("対応するページがないリンクはそのまま残る", () => {
    const html = '<a class="wikilink" data-page-id="p_gone">消えたページ</a>';
    expect(syncLinkLabels(html, new Map())).toBe(html);
  });

  it("リンク以外のHTMLは変更されない", () => {
    const html = "<strong>太字</strong>と<em>斜体</em>";
    expect(syncLinkLabels(html, new Map())).toBe(html);
  });
});

describe("normalizeExternalUrl", () => {
  it("スキーム付きのURLはそのまま使える", () => {
    expect(normalizeExternalUrl("https://example.com/path")).toBe("https://example.com/path");
  });
  it("スキームが省略されていればhttps://を補う", () => {
    expect(normalizeExternalUrl("example.com")).toBe("https://example.com/");
  });
  it("前後の空白は取り除かれる", () => {
    expect(normalizeExternalUrl("  example.com  ")).toBe("https://example.com/");
  });
  it("http/https以外のスキーム(javascript:等)は拒否される", () => {
    expect(normalizeExternalUrl("javascript:alert(1)")).toBeNull();
  });
  it("空文字はnull", () => {
    expect(normalizeExternalUrl("")).toBeNull();
    expect(normalizeExternalUrl("   ")).toBeNull();
  });
  it("URLとして解釈不能な文字列はnull", () => {
    expect(normalizeExternalUrl("http://")).toBeNull();
  });
});
