/**
 * クライアント側の編集モデル。
 * サーバー形式(Page/Block + content JSON)と相互変換する。
 */

import type {
  Block,
  BlockContent,
  BlockType,
  ChecklistItem,
  ListItem,
  PageWithBlocks,
} from "@/lib/types";

export type TextyType = "heading1" | "heading2" | "paragraph" | "quote" | "code";

export type ClientBlock =
  | { id: string; type: TextyType; html: string }
  | { id: string; type: "checklist"; items: ChecklistItem[] }
  | { id: string; type: "bulletlist" | "numberlist"; items: ListItem[] }
  | { id: string; type: "table"; rows: string[][] }
  | { id: string; type: "image"; src: string; caption: string; uploading?: boolean };

export interface ClientPage {
  id: string;
  title: string;
  parentId: string | null;
  childOrder: string[];
  tags: string[];
  icon: string;
  blocks: ClientBlock[];
}

export interface Model {
  pages: Record<string, ClientPage>;
  rootOrder: string[];
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export const TEXTY_TYPES: TextyType[] = [
  "heading1",
  "heading2",
  "paragraph",
  "quote",
  "code",
];

export function isTexty(b: ClientBlock): b is Extract<ClientBlock, { html: string }> {
  return (TEXTY_TYPES as string[]).includes(b.type);
}

// ---------- サーバー形式 → クライアント形式 ----------

export function fromServer(pages: PageWithBlocks[]): Model {
  const model: Model = { pages: {}, rootOrder: [] };
  for (const p of pages) {
    model.pages[p.id] = {
      id: p.id,
      title: p.title,
      parentId: p.parentId,
      childOrder: [],
      tags: p.tags,
      icon: p.icon,
      blocks: p.blocks
        .slice()
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map(blockFromServer)
        .filter((b): b is ClientBlock => b !== null),
    };
  }
  const byParent = new Map<string | null, PageWithBlocks[]>();
  for (const p of pages) {
    const arr = byParent.get(p.parentId) ?? [];
    arr.push(p);
    byParent.set(p.parentId, arr);
  }
  for (const [parentId, kids] of byParent) {
    const sorted = kids
      .slice()
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((p) => p.id);
    if (parentId === null) model.rootOrder = sorted;
    else if (model.pages[parentId]) model.pages[parentId].childOrder = sorted;
  }
  return model;
}

function blockFromServer(b: Block): ClientBlock | null {
  const c = b.content as Record<string, unknown>;
  switch (b.type) {
    case "heading1":
    case "heading2":
    case "paragraph":
    case "quote":
    case "code":
      return { id: b.id, type: b.type, html: String(c.html ?? "") };
    case "checklist":
      return {
        id: b.id,
        type: "checklist",
        items: Array.isArray(c.items) ? (c.items as ChecklistItem[]) : [],
      };
    case "bulletlist":
    case "numberlist":
      return {
        id: b.id,
        type: b.type,
        items: Array.isArray(c.items) ? (c.items as ListItem[]) : [],
      };
    case "table":
      return {
        id: b.id,
        type: "table",
        rows: Array.isArray(c.rows) ? (c.rows as string[][]) : [[""]],
      };
    case "image":
      return {
        id: b.id,
        type: "image",
        src: String(c.src ?? ""),
        caption: String(c.caption ?? ""),
      };
    default:
      return null;
  }
}

// ---------- クライアント形式 → サーバー形式 ----------

export function blocksToServer(pageId: string, blocks: ClientBlock[]): Block[] {
  const ts = new Date().toISOString();
  return blocks.map((b, i) => ({
    id: b.id,
    pageId,
    orderIndex: i,
    type: b.type as BlockType,
    content: blockContentToServer(b),
    createdAt: ts,
    updatedAt: ts,
  }));
}

function blockContentToServer(b: ClientBlock): BlockContent {
  switch (b.type) {
    case "checklist":
      return { items: b.items };
    case "bulletlist":
    case "numberlist":
      return { items: b.items };
    case "table":
      return { rows: b.rows };
    case "image":
      return { src: b.src, caption: b.caption };
    default:
      return { html: b.html };
  }
}

/** 初期表示・オフライン時に使うローカルのホームページ */
export function seedModel(): Model {
  return {
    pages: {
      home: {
        id: "home",
        title: "ホーム",
        parentId: null,
        childOrder: [],
        tags: [],
        icon: "🏠",
        blocks: [
          { id: uid("b"), type: "heading1", html: "ホーム" },
          {
            id: uid("b"),
            type: "paragraph",
            html: "ようこそ Memomento へ。左のサイドバーからページを作成できます。",
          },
        ],
      },
    },
    rootOrder: ["home"],
  };
}
