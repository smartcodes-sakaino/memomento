export type BlockType =
  | "heading1"
  | "heading2"
  | "paragraph"
  | "checklist"
  | "bulletlist"
  | "numberlist"
  | "quote"
  | "code"
  | "table"
  | "image";

export const BLOCK_TYPES: BlockType[] = [
  "heading1",
  "heading2",
  "paragraph",
  "checklist",
  "bulletlist",
  "numberlist",
  "quote",
  "code",
  "table",
  "image",
];

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface ListItem {
  id: string;
  text: string;
}

export type BlockContent =
  | { html: string } // heading1 / heading2 / paragraph / quote / code
  | { items: ChecklistItem[] } // checklist
  | { items: ListItem[] } // bulletlist / numberlist
  | { rows: string[][] } // table
  | { src: string; caption: string }; // image

export interface Block {
  id: string;
  pageId: string;
  orderIndex: number;
  type: BlockType;
  content: BlockContent;
  createdAt: string;
  updatedAt: string;
}

export interface Page {
  id: string;
  title: string;
  parentId: string | null;
  orderIndex: number;
  icon: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PageWithBlocks extends Page {
  blocks: Block[];
}

/** ホームページの固定ID。削除・移動不可 */
export const HOME_PAGE_ID = "home";
