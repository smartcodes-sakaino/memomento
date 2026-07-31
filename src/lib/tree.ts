import { HOME_PAGE_ID, type Page } from "./types";

/**
 * ページを targetParentId の下へ移動できるか判定する。
 * - ホームは移動不可
 * - 自分自身・自分の子孫の下へは移動不可(循環参照防止)
 * - null(トップレベル)への移動は常に可
 */
export function canMoveTo(
  pages: Page[],
  pageId: string,
  targetParentId: string | null
): boolean {
  if (pageId === HOME_PAGE_ID) return false;
  if (targetParentId === null) return true;
  if (targetParentId === pageId) return false;

  const byId = new Map(pages.map((p) => [p.id, p]));
  if (!byId.has(pageId) || !byId.has(targetParentId)) return false;

  // targetParentId から親を辿り、pageId に行き着いたら循環
  let cur = byId.get(targetParentId);
  while (cur) {
    if (cur.id === pageId) return false;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return true;
}

/** 自分自身を含む全子孫のIDを収集する(削除時に使用) */
export function collectDescendantIds(pages: Page[], pageId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const p of pages) {
    if (p.parentId === null) continue;
    const arr = childrenByParent.get(p.parentId) ?? [];
    arr.push(p.id);
    childrenByParent.set(p.parentId, arr);
  }
  const result: string[] = [];
  const stack = [pageId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }
  return result;
}

/** 指定した親の直下の子ページをorder_index順で返す */
export function childrenOf(pages: Page[], parentId: string | null): Page[] {
  return pages
    .filter((p) => p.parentId === parentId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

/** 指定した親の下に新規追加する際のorder_index(末尾+1) */
export function nextOrderIndex(pages: Page[], parentId: string | null): number {
  const kids = childrenOf(pages, parentId);
  if (kids.length === 0) return 0;
  return Math.max(...kids.map((p) => p.orderIndex)) + 1;
}
