import { describe, it, expect } from "vitest";
import { extractDocId, extractTabId, parseGoogleDoc, type DocsApiDocument } from "@/lib/docs-import";

function para(
  text: string,
  opts: { style?: string; bold?: boolean; italic?: boolean; bullet?: { listId: string; nestingLevel?: number } } = {}
) {
  return {
    paragraph: {
      elements: [{ textRun: { content: text + "\n", textStyle: { bold: opts.bold, italic: opts.italic } } }],
      paragraphStyle: opts.style ? { namedStyleType: opts.style } : undefined,
      bullet: opts.bullet,
    },
  };
}

describe("extractDocId", () => {
  it("編集URLからIDを取り出す", () => {
    expect(extractDocId("https://docs.google.com/document/d/1AbC-XyZ_123/edit")).toBe("1AbC-XyZ_123");
  });
  it("クエリパラメータ付きURLからもIDを取り出す", () => {
    expect(extractDocId("https://docs.google.com/document/d/1AbC-XyZ_123/edit?usp=sharing")).toBe(
      "1AbC-XyZ_123"
    );
  });
  it("生のIDならそのまま返す", () => {
    expect(extractDocId("1AbC-XyZ_123456789")).toBe("1AbC-XyZ_123456789");
  });
  it("形式が不正なら null を返す", () => {
    expect(extractDocId("https://example.com/hello")).toBeNull();
    expect(extractDocId("short")).toBeNull();
    expect(extractDocId("")).toBeNull();
  });
});

describe("extractTabId", () => {
  it("URLの?tab=からタブIDを取り出す", () => {
    expect(extractTabId("https://docs.google.com/document/d/abc/edit?tab=t.nwrwo97zgx4b")).toBe(
      "t.nwrwo97zgx4b"
    );
  });
  it("#heading=などが続いていても正しく取り出す", () => {
    expect(
      extractTabId("https://docs.google.com/document/d/abc/edit?tab=t.xyz#heading=h.abc")
    ).toBe("t.xyz");
  });
  it("tabパラメータが無ければnull", () => {
    expect(extractTabId("https://docs.google.com/document/d/abc/edit")).toBeNull();
  });
});

describe("parseGoogleDoc(タブ対応)", () => {
  it("タブが複数ある場合、指定したtabIdのタブだけを取り込む", () => {
    const doc: DocsApiDocument = {
      title: "無視されるトップレベルタイトル",
      tabs: [
        {
          tabProperties: { tabId: "t.first", title: "1つ目のタブ" },
          documentTab: { body: { content: [para("1つ目の本文")] } },
        },
        {
          tabProperties: { tabId: "t.second", title: "2つ目のタブ" },
          documentTab: { body: { content: [para("2つ目の本文")] } },
        },
      ],
    };
    const result = parseGoogleDoc(doc, "t.second");
    expect(result.title).toBe("2つ目のタブ");
    expect(result.blocks).toEqual([{ type: "paragraph", html: "2つ目の本文" }]);
  });

  it("tabIdを指定しない/一致しない場合は最初のタブを使う", () => {
    const doc: DocsApiDocument = {
      tabs: [
        {
          tabProperties: { tabId: "t.first", title: "1つ目のタブ" },
          documentTab: { body: { content: [para("1つ目の本文")] } },
        },
        {
          tabProperties: { tabId: "t.second", title: "2つ目のタブ" },
          documentTab: { body: { content: [para("2つ目の本文")] } },
        },
      ],
    };
    expect(parseGoogleDoc(doc, "t.does-not-exist").title).toBe("1つ目のタブ");
    expect(parseGoogleDoc(doc, null).title).toBe("1つ目のタブ");
  });

  it("タブごとに別のリスト定義(lists)を正しく参照する", () => {
    const doc: DocsApiDocument = {
      tabs: [
        {
          tabProperties: { tabId: "t.a" },
          documentTab: {
            body: {
              content: [
                para("番号1", { bullet: { listId: "L" } }),
                para("番号2", { bullet: { listId: "L" } }),
              ],
            },
            lists: { L: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } } },
          },
        },
      ],
    };
    expect(parseGoogleDoc(doc, "t.a").blocks).toEqual([
      {
        type: "numberlist",
        items: [
          { text: "番号1", level: 0 },
          { text: "番号2", level: 0 },
        ],
      },
    ]);
  });

  it("タブが無い旧来形式のドキュメントも引き続き取り込める", () => {
    const doc: DocsApiDocument = { title: "旧形式", body: { content: [para("本文")] } };
    expect(parseGoogleDoc(doc, "t.anything")).toEqual({
      title: "旧形式",
      blocks: [{ type: "paragraph", html: "本文" }],
    });
  });
});

describe("parseGoogleDoc", () => {
  it("タイトルを取得する(未設定なら無題)", () => {
    expect(parseGoogleDoc({ title: "議事録", body: { content: [] } }).title).toBe("議事録");
    expect(parseGoogleDoc({ body: { content: [] } }).title).toBe("無題のページ");
  });

  it("HEADING_1/HEADING_2は見出しブロックになる", () => {
    const doc: DocsApiDocument = {
      title: "t",
      body: { content: [para("大見出し", { style: "HEADING_1" }), para("小見出し", { style: "HEADING_2" })] },
    };
    const { blocks } = parseGoogleDoc(doc);
    expect(blocks).toEqual([
      { type: "heading1", html: "大見出し" },
      { type: "heading2", html: "小見出し" },
    ]);
  });

  it("通常の段落はparagraphになり、太字・斜体はHTMLタグになる", () => {
    const doc: DocsApiDocument = {
      body: { content: [para("普通の文", {}), para("強調", { bold: true }), para("斜体", { italic: true })] },
    };
    const { blocks } = parseGoogleDoc(doc);
    expect(blocks).toEqual([
      { type: "paragraph", html: "普通の文" },
      { type: "paragraph", html: "<strong>強調</strong>" },
      { type: "paragraph", html: "<em>斜体</em>" },
    ]);
  });

  it("空の段落は無視される", () => {
    const doc: DocsApiDocument = { body: { content: [para(""), para("本文")] } };
    expect(parseGoogleDoc(doc).blocks).toEqual([{ type: "paragraph", html: "本文" }]);
  });

  it("連続する箇条書き段落は1つのbulletlistブロックにまとまる", () => {
    const doc: DocsApiDocument = {
      lists: { L1: { listProperties: { nestingLevels: [{}] } } }, // glyphType無し→箇条書き
      body: {
        content: [
          para("1個目", { bullet: { listId: "L1" } }),
          para("2個目", { bullet: { listId: "L1" } }),
          para("本文に戻る"),
        ],
      },
    };
    const { blocks } = parseGoogleDoc(doc);
    expect(blocks).toEqual([
      {
        type: "bulletlist",
        items: [
          { text: "1個目", level: 0 },
          { text: "2個目", level: 0 },
        ],
      },
      { type: "paragraph", html: "本文に戻る" },
    ]);
  });

  it("glyphTypeが数字系ならnumberlistとして判定される", () => {
    const doc: DocsApiDocument = {
      lists: { L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } } },
      body: {
        content: [
          para("手順1", { bullet: { listId: "L1" } }),
          para("手順2", { bullet: { listId: "L1" } }),
        ],
      },
    };
    expect(parseGoogleDoc(doc).blocks).toEqual([
      {
        type: "numberlist",
        items: [
          { text: "手順1", level: 0 },
          { text: "手順2", level: 0 },
        ],
      },
    ]);
  });

  it("異なるlistIdのリストは別ブロックに分かれる", () => {
    const doc: DocsApiDocument = {
      lists: { A: { listProperties: { nestingLevels: [{}] } }, B: { listProperties: { nestingLevels: [{}] } } },
      body: {
        content: [
          para("A-1", { bullet: { listId: "A" } }),
          para("B-1", { bullet: { listId: "B" } }),
        ],
      },
    };
    expect(parseGoogleDoc(doc).blocks).toEqual([
      { type: "bulletlist", items: [{ text: "A-1", level: 0 }] },
      { type: "bulletlist", items: [{ text: "B-1", level: 0 }] },
    ]);
  });

  it("入れ子(nestingLevel)のある箇条書きは、階層(level)を保ったまま同じブロックにまとまる", () => {
    const doc: DocsApiDocument = {
      lists: {
        L1: {
          listProperties: {
            nestingLevels: [{}, {}],
          },
        },
      },
      body: {
        content: [
          para("親", { bullet: { listId: "L1", nestingLevel: 0 } }),
          para("子", { bullet: { listId: "L1", nestingLevel: 1 } }),
          para("親2", { bullet: { listId: "L1", nestingLevel: 0 } }),
        ],
      },
    };
    expect(parseGoogleDoc(doc).blocks).toEqual([
      {
        type: "bulletlist",
        items: [
          { text: "親", level: 0 },
          { text: "子", level: 1 },
          { text: "親2", level: 0 },
        ],
      },
    ]);
  });

  it("表はtableブロックとして各セルのテキストが並ぶ", () => {
    const doc: DocsApiDocument = {
      body: {
        content: [
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    { content: [para("A")] },
                    { content: [para("B")] },
                  ],
                },
                {
                  tableCells: [
                    { content: [para("1")] },
                    { content: [para("2")] },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    expect(parseGoogleDoc(doc).blocks).toEqual([
      { type: "table", rows: [["A", "B"], ["1", "2"]] },
    ]);
  });

  it("ブロックが1つも無いドキュメントでも壊れない", () => {
    expect(parseGoogleDoc({ body: { content: [] } }).blocks).toEqual([]);
  });
});
