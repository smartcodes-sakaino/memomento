import { describe, it, expect } from "vitest";
import {
  pageToRow,
  rowToPage,
  blockToRow,
  rowToBlock,
  PAGES_HEADER,
  BLOCKS_HEADER,
} from "@/lib/sheetcodec";
import type { Block, Page } from "@/lib/types";

const samplePage: Page = {
  id: "p_123",
  title: "学習ノート",
  parentId: "home",
  orderIndex: 2,
  icon: "📚",
  tags: ["学習", "資格"],
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T01:00:00.000Z",
};

const sampleBlock: Block = {
  id: "b_456",
  pageId: "p_123",
  orderIndex: 0,
  type: "checklist",
  content: {
    items: [{ id: "i_1", text: "過去問を解く", done: false }],
  },
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T01:00:00.000Z",
};

describe("Pages行の変換", () => {
  it("ページ→行→ページで元に戻る(ラウンドトリップ)", () => {
    expect(rowToPage(pageToRow(samplePage))).toEqual(samplePage);
  });

  it("行の列数はヘッダーと一致する", () => {
    expect(pageToRow(samplePage)).toHaveLength(PAGES_HEADER.length);
  });

  it("トップレベルページのparent_idは空文字で保存される", () => {
    const row = pageToRow({ ...samplePage, parentId: null });
    expect(row[2]).toBe("");
    expect(rowToPage(row).parentId).toBeNull();
  });

  it("タグはJSON配列の文字列として保存される", () => {
    const row = pageToRow(samplePage);
    expect(JSON.parse(row[5])).toEqual(["学習", "資格"]);
  });

  it("壊れたtagsセルは空配列として読み込まれる(クラッシュしない)", () => {
    const row = pageToRow(samplePage);
    row[5] = "not-json";
    expect(rowToPage(row).tags).toEqual([]);
  });

  it("order_indexが数値でないセルは0として読み込まれる", () => {
    const row = pageToRow(samplePage);
    row[3] = "abc";
    expect(rowToPage(row).orderIndex).toBe(0);
  });
});

describe("Blocks行の変換", () => {
  it("ブロック→行→ブロックで元に戻る(ラウンドトリップ)", () => {
    expect(rowToBlock(blockToRow(sampleBlock))).toEqual(sampleBlock);
  });

  it("行の列数はヘッダーと一致する", () => {
    expect(blockToRow(sampleBlock)).toHaveLength(BLOCKS_HEADER.length);
  });

  it("contentはJSON文字列として保存される", () => {
    const row = blockToRow(sampleBlock);
    expect(JSON.parse(row[4])).toEqual(sampleBlock.content);
  });

  it("未知のtypeの行はnullを返す(シートを壊さない)", () => {
    const row = blockToRow(sampleBlock);
    row[3] = "unknown_type";
    expect(rowToBlock(row)).toBeNull();
  });

  it("壊れたcontentセルはnullを返す(クラッシュしない)", () => {
    const row = blockToRow(sampleBlock);
    row[4] = "{broken json";
    expect(rowToBlock(row)).toBeNull();
  });
});
