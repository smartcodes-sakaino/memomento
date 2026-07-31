import {
  BLOCK_TYPES,
  type Block,
  type BlockContent,
  type BlockType,
  type Page,
} from "./types";

/** Pagesシートの列構成(DB設計書に準拠) */
export const PAGES_HEADER = [
  "id",
  "title",
  "parent_id",
  "order_index",
  "icon",
  "tags",
  "created_at",
  "updated_at",
] as const;

/** Blocksシートの列構成(DB設計書に準拠) */
export const BLOCKS_HEADER = [
  "id",
  "page_id",
  "order_index",
  "type",
  "content",
  "created_at",
  "updated_at",
] as const;

function toNumber(cell: string): number {
  const n = Number(cell);
  return Number.isFinite(n) ? n : 0;
}

export function pageToRow(page: Page): string[] {
  return [
    page.id,
    page.title,
    page.parentId ?? "",
    String(page.orderIndex),
    page.icon,
    JSON.stringify(page.tags),
    page.createdAt,
    page.updatedAt,
  ];
}

export function rowToPage(row: string[]): Page {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row[5] ?? "[]");
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
  } catch {
    // 壊れたセルは空配列として扱う
  }
  return {
    id: row[0] ?? "",
    title: row[1] ?? "",
    parentId: row[2] ? row[2] : null,
    orderIndex: toNumber(row[3] ?? "0"),
    icon: row[4] || "🗒️",
    tags,
    createdAt: row[6] ?? "",
    updatedAt: row[7] ?? "",
  };
}

export function blockToRow(block: Block): string[] {
  return [
    block.id,
    block.pageId,
    String(block.orderIndex),
    block.type,
    JSON.stringify(block.content),
    block.createdAt,
    block.updatedAt,
  ];
}

/** 不正な行(未知type・壊れたJSON)はnullを返し、呼び出し側でスキップする */
export function rowToBlock(row: string[]): Block | null {
  const type = row[3] as BlockType;
  if (!BLOCK_TYPES.includes(type)) return null;
  let content: BlockContent;
  try {
    content = JSON.parse(row[4] ?? "");
  } catch {
    return null;
  }
  if (content === null || typeof content !== "object") return null;
  return {
    id: row[0] ?? "",
    pageId: row[1] ?? "",
    orderIndex: toNumber(row[2] ?? "0"),
    type,
    content,
    createdAt: row[5] ?? "",
    updatedAt: row[6] ?? "",
  };
}
