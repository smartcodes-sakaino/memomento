import { describe, it, expect } from "vitest";
import { htmlToText, renderPagesAsMarkdown } from "@/lib/markdown-export";
import type { Block, Page } from "@/lib/types";

function page(id: string, title: string, parentId: string | null, opts: Partial<Page> = {}): Page {
  return {
    id,
    title,
    parentId,
    orderIndex: 0,
    icon: "🗒️",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...opts,
  };
}

describe("htmlToText", () => {
  it("リンクは表示テキストだけになる", () => {
    expect(htmlToText('参加者: <a class="wikilink" data-page-id="p1">田中さん</a>')).toBe(
      "参加者: 田中さん"
    );
  });
  it("太字・斜体・コードはMarkdown記法に変換される", () => {
    expect(htmlToText("<strong>太字</strong>と<em>斜体</em>と<code>code</code>")).toBe(
      "**太字**と*斜体*と`code`"
    );
  });
  it("吹き出しはテキスト+補足として展開される", () => {
    expect(
      htmlToText('<span class="callout-inline" data-note="メモ内容">対象</span>')
    ).toBe("対象(補足: メモ内容)");
  });
  it("HTMLエンティティがデコードされる", () => {
    expect(htmlToText("A &amp; B &lt;tag&gt;")).toBe("A & B <tag>");
  });
});

describe("renderPagesAsMarkdown", () => {
  it("見出し・タグ・パスが含まれる", () => {
    const pages = [page("home", "ホーム", null)];
    const blocks: Block[] = [
      {
        id: "b1",
        pageId: "home",
        orderIndex: 0,
        type: "paragraph",
        content: { html: "本文です" },
        createdAt: "",
        updatedAt: "",
      },
    ];
    const md = renderPagesAsMarkdown(pages, blocks);
    expect(md).toContain("## 🗒️ ホーム");
    expect(md).toContain("本文です");
  });

  it("親ページの直後に子ページが続く(階層順)", () => {
    const pages = [
      page("home", "ホーム", null),
      page("study", "学習ノート", "home", { tags: ["学習"] }),
      page("ch1", "第1章", "study"),
    ];
    const md = renderPagesAsMarkdown(pages, []);
    const iHome = md.indexOf("## 🗒️ ホーム");
    const iStudy = md.indexOf("## 🗒️ 学習ノート");
    const iCh1 = md.indexOf("## 🗒️ 第1章");
    expect(iHome).toBeGreaterThanOrEqual(0);
    expect(iStudy).toBeGreaterThan(iHome);
    expect(iCh1).toBeGreaterThan(iStudy);
    expect(md).toContain("パス: ホーム / 学習ノート / 第1章");
    expect(md).toContain("タグ: #学習");
  });

  it("チェックリスト・表・画像がMarkdown表現になる", () => {
    const pages = [page("home", "ホーム", null)];
    const blocks: Block[] = [
      {
        id: "b1",
        pageId: "home",
        orderIndex: 0,
        type: "checklist",
        content: { items: [{ id: "i1", text: "やる", done: true }, { id: "i2", text: "まだ", done: false }] },
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "b2",
        pageId: "home",
        orderIndex: 1,
        type: "table",
        content: { rows: [["A", "B"], ["1", "2"]] },
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "b3",
        pageId: "home",
        orderIndex: 2,
        type: "image",
        content: { src: "/api/images/x", caption: "図解" },
        createdAt: "",
        updatedAt: "",
      },
    ];
    const md = renderPagesAsMarkdown(pages, blocks);
    expect(md).toContain("- [x] やる");
    expect(md).toContain("- [ ] まだ");
    expect(md).toContain("| A | B |");
    expect(md).toContain("(画像: 図解)");
    // 内部APIのURLは埋め込まれない(NotebookLM側からアクセスできないため)
    expect(md).not.toContain("/api/images/x");
  });

  it("ブロックが無いページでも壊れない", () => {
    const md = renderPagesAsMarkdown([page("home", "ホーム", null)], []);
    expect(md).toContain("ホーム");
  });

  it("includeIdsを指定すると選択したページだけが本文になる", () => {
    const pages = [
      page("home", "ホーム", null),
      page("study", "学習ノート", "home"),
      page("ch1", "第1章", "study"),
    ];
    const blocks: Block[] = [
      { id: "b1", pageId: "ch1", orderIndex: 0, type: "paragraph", content: { html: "章の本文" }, createdAt: "", updatedAt: "" },
    ];
    const md = renderPagesAsMarkdown(pages, blocks, new Set(["ch1"]));
    expect(md).not.toContain("## 🗒️ ホーム");
    expect(md).not.toContain("## 🗒️ 学習ノート");
    expect(md).toContain("## 🗒️ 第1章");
    // 選択されていない祖先でも、パス表示には名前が残る(文脈のため)
    expect(md).toContain("パス: ホーム / 学習ノート / 第1章");
    expect(md).toContain("章の本文");
  });

  it("includeIdsが空集合なら何も出力しない旨のメッセージになる", () => {
    const md = renderPagesAsMarkdown([page("home", "ホーム", null)], [], new Set());
    expect(md).toContain("選択されたページに内容がありません");
  });
});
