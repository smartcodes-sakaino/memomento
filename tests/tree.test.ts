import { describe, it, expect } from "vitest";
import {
  canMoveTo,
  collectDescendantIds,
  childrenOf,
  nextOrderIndex,
} from "@/lib/tree";
import { HOME_PAGE_ID, type Page } from "@/lib/types";

function page(id: string, parentId: string | null, orderIndex = 0): Page {
  return {
    id,
    title: id,
    parentId,
    orderIndex,
    icon: "🗒️",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// ツリー構成:
// home
// ├── a
// │   └── a1
// │       └── a1x
// └── b
const pages: Page[] = [
  page(HOME_PAGE_ID, null, 0),
  page("a", HOME_PAGE_ID, 0),
  page("a1", "a", 0),
  page("a1x", "a1", 0),
  page("b", HOME_PAGE_ID, 1),
];

describe("canMoveTo(循環参照・ホームの保護)", () => {
  it("兄弟ページの下への移動は許可される", () => {
    expect(canMoveTo(pages, "b", "a")).toBe(true);
  });

  it("自分自身の下への移動は拒否される", () => {
    expect(canMoveTo(pages, "a", "a")).toBe(false);
  });

  it("自分の子の下への移動は拒否される(循環参照)", () => {
    expect(canMoveTo(pages, "a", "a1")).toBe(false);
  });

  it("自分の孫の下への移動も拒否される", () => {
    expect(canMoveTo(pages, "a", "a1x")).toBe(false);
  });

  it("ホームページはどこへも移動できない", () => {
    expect(canMoveTo(pages, HOME_PAGE_ID, "a")).toBe(false);
  });

  it("トップレベル(parent=null)への移動は許可される", () => {
    expect(canMoveTo(pages, "a1", null)).toBe(true);
  });

  it("存在しない移動先は拒否される", () => {
    expect(canMoveTo(pages, "a", "nonexistent")).toBe(false);
  });
});

describe("collectDescendantIds(削除時の子孫収集)", () => {
  it("子・孫・ひ孫まで全て収集される(自分自身を含む)", () => {
    const ids = collectDescendantIds(pages, "a");
    expect(new Set(ids)).toEqual(new Set(["a", "a1", "a1x"]));
  });

  it("葉ページは自分自身のみ", () => {
    expect(collectDescendantIds(pages, "b")).toEqual(["b"]);
  });
});

describe("childrenOf / nextOrderIndex", () => {
  it("直下の子がorder_index順で返る", () => {
    const kids = childrenOf(pages, HOME_PAGE_ID).map((p) => p.id);
    expect(kids).toEqual(["a", "b"]);
  });

  it("次のorder_indexは末尾+1になる", () => {
    expect(nextOrderIndex(pages, HOME_PAGE_ID)).toBe(2);
  });

  it("子がいない場合は0になる", () => {
    expect(nextOrderIndex(pages, "b")).toBe(0);
  });
});
