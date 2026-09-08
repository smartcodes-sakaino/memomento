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
  it("wikiリンクは表示テキストだけになる", () => {
    expect(htmlToText('参加者: <a class="wikilink" data-page-id="p1">田中さん</a>')).toBe(
      "参加者: 田中さん"
    );
  });
  it("外部リンクはMarkdownのリンク記法(URL付き)になる", () => {
    expect(
      htmlToText('詳細は<a class="ext-link" href="https://example.com/">こちら</a>です')
    ).toBe("詳細は[こちら](https://example.com/)です");
  });
  it("外部リンクは属性の順序が入れ替わっても解釈できる", () => {
    expect(
      htmlToText('<a href="https://example.com/" target="_blank" class="ext-link">example</a>')
    ).toBe("[example](https://example.com/)");
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
  it("本文に埋め込まれた生の<table>はMarkdownの表になる(Googleドキュメント等からの貼り付け対策)", () => {
    const html =
      "<table><tbody>" +
      "<tr><td><p>ID</p></td><td><p>headmaster_smartcodes</p></td></tr>" +
      "<tr><td><p>メール</p></td><td><p>headmaster@smartcodes.jp</p></td></tr>" +
      "</tbody></table>";
    const md = htmlToText(html);
    expect(md).toContain("| ID | headmaster_smartcodes |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| メール | headmaster@smartcodes.jp |");
  });
  it("表のセルの中の太字などの装飾もMarkdownに変換される", () => {
    const html = "<table><tr><th><strong>項目</strong></th><th>値</th></tr></table>";
    expect(htmlToText(html)).toContain("| **項目** | 値 |");
  });
});

describe("renderPagesAsMarkdown", () => {
  it("見出しに本文が続く。アイコンやパス表記などの飾りは含まれない", () => {
    const pages = [page("home", "ホーム", null, { icon: "🏠" })];
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
    expect(md).toContain("## ホーム");
    expect(md).toContain("本文です");
    expect(md).not.toContain("🏠");
    expect(md).not.toContain("パス:");
    expect(md).not.toContain("---");
    expect(md).not.toContain("Memomento エクスポート");
  });

  it("親子関係は見出しレベルの深さで表現される(##→###→####)", () => {
    const pages = [
      page("home", "ホーム", null),
      page("study", "学習ノート", "home", { tags: ["学習"] }),
      page("ch1", "第1章", "study"),
    ];
    const md = renderPagesAsMarkdown(pages, []);
    expect(md).toContain("## ホーム");
    expect(md).toContain("### 学習ノート");
    expect(md).toContain("#### 第1章");
    expect(md).toContain("タグ: #学習");
    const iHome = md.indexOf("## ホーム");
    const iStudy = md.indexOf("### 学習ノート");
    const iCh1 = md.indexOf("#### 第1章");
    expect(iStudy).toBeGreaterThan(iHome);
    expect(iCh1).toBeGreaterThan(iStudy);
  });

  it("ページ内の見出しブロックは、ページの見出しレベルより深くなる", () => {
    const pages = [page("home", "ホーム", null)];
    const blocks: Block[] = [
      { id: "b1", pageId: "home", orderIndex: 0, type: "heading1", content: { html: "節1" }, createdAt: "", updatedAt: "" },
      { id: "b2", pageId: "home", orderIndex: 1, type: "heading2", content: { html: "節2" }, createdAt: "", updatedAt: "" },
    ];
    const md = renderPagesAsMarkdown(pages, blocks);
    expect(md).toContain("### 節1");
    expect(md).toContain("#### 節2");
  });

  it("階層(level)付きの箇条書き/番号付きリストは、インデントと階層ごとの番号で出力される", () => {
    const pages = [page("home", "ホーム", null)];
    const blocks: Block[] = [
      {
        id: "b1",
        pageId: "home",
        orderIndex: 0,
        type: "numberlist",
        content: {
          items: [
            { id: "i1", text: "親1", level: 0 },
            { id: "i2", text: "子1", level: 1 },
            { id: "i3", text: "子2", level: 1 },
            { id: "i4", text: "親2", level: 0 },
          ],
        },
        createdAt: "",
        updatedAt: "",
      },
    ];
    const md = renderPagesAsMarkdown(pages, blocks);
    const lines = md.split("\n").filter((l) => l.trim());
    expect(lines).toContain("1. 親1");
    expect(lines).toContain("  1. 子1");
    expect(lines).toContain("  2. 子2");
    expect(lines).toContain("2. 親2");
  });

  it("チェックリスト・表がMarkdown表現になり、キャプション無しの画像は出力されない", () => {
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
        content: { src: "/api/images/x", caption: "" },
        createdAt: "",
        updatedAt: "",
      },
    ];
    const md = renderPagesAsMarkdown(pages, blocks);
    expect(md).toContain("- [x] やる");
    expect(md).toContain("- [ ] まだ");
    expect(md).toContain("| A | B |");
    expect(md).not.toContain("画像");
    expect(md).not.toContain("/api/images/x");
  });

  it("画像にキャプションがあれば出力される", () => {
    const pages = [page("home", "ホーム", null)];
    const blocks: Block[] = [
      { id: "b1", pageId: "home", orderIndex: 0, type: "image", content: { src: "/api/images/x", caption: "図解" }, createdAt: "", updatedAt: "" },
    ];
    const md = renderPagesAsMarkdown(pages, blocks);
    expect(md).toContain("(画像: 図解)");
  });

  it("ブロックが無いページでも壊れない", () => {
    const md = renderPagesAsMarkdown([page("home", "ホーム", null)], []);
    expect(md).toContain("ホーム");
  });

  it("includeIdsを指定すると選択したページだけが本文になる(見出しレベルは元の深さを保つ)", () => {
    const pages = [
      page("home", "ホーム", null),
      page("study", "学習ノート", "home"),
      page("ch1", "第1章", "study"),
    ];
    const blocks: Block[] = [
      { id: "b1", pageId: "ch1", orderIndex: 0, type: "paragraph", content: { html: "章の本文" }, createdAt: "", updatedAt: "" },
    ];
    const md = renderPagesAsMarkdown(pages, blocks, new Set(["ch1"]));
    expect(md).not.toContain("ホーム");
    expect(md).not.toContain("学習ノート");
    expect(md).toContain("#### 第1章");
    expect(md).toContain("章の本文");
  });

  it("includeIdsが空集合なら何も出力しない旨のメッセージになる", () => {
    const md = renderPagesAsMarkdown([page("home", "ホーム", null)], [], new Set());
    expect(md).toContain("選択されたページに内容がありません");
  });
});
