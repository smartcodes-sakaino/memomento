import { describe, it, expect } from "vitest";
import { extractLinkedPageIds, syncLinkLabels } from "@/lib/wikilink";

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
