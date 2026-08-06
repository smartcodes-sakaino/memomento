/**
 * Google Docs API (documents.get) のレスポンスを、Memomentoのブロック列に変換する。
 * 見出し(HEADING_1/2系)・箇条書き/番号付きリスト・表を可能な範囲で保って取り込む。
 * Edge runtime(DOM無し)で動くよう、Docs APIのJSON構造を直接たどって処理する。
 *
 * Googleドキュメントの「タブ」機能に対応するため、documents.get は
 * includeTabsContent=true 付きで呼び出す想定。タブが無い旧来形式のドキュメントにも
 * 対応する(その場合は document.body を直接使う)。
 */

import { escapeHtml } from "./wikilink";

export interface DocsTextRun {
  content: string;
  textStyle?: { bold?: boolean; italic?: boolean };
}
export interface DocsParagraphElement {
  textRun?: DocsTextRun;
}
export interface DocsParagraphStyle {
  namedStyleType?: string;
}
export interface DocsBullet {
  listId: string;
  nestingLevel?: number;
}
export interface DocsParagraph {
  elements?: DocsParagraphElement[];
  paragraphStyle?: DocsParagraphStyle;
  bullet?: DocsBullet;
}
export interface DocsTableCell {
  content?: DocsStructuralElement[];
}
export interface DocsTableRow {
  tableCells?: DocsTableCell[];
}
export interface DocsTable {
  tableRows?: DocsTableRow[];
}
export interface DocsStructuralElement {
  paragraph?: DocsParagraph;
  table?: DocsTable;
}
export interface DocsListLevel {
  glyphType?: string;
}
export interface DocsList {
  listProperties?: { nestingLevels?: DocsListLevel[] };
}
export interface DocsTab {
  tabProperties?: { tabId?: string; title?: string };
  documentTab?: {
    body?: { content?: DocsStructuralElement[] };
    lists?: Record<string, DocsList>;
  };
  childTabs?: DocsTab[];
}
export interface DocsApiDocument {
  title?: string;
  body?: { content?: DocsStructuralElement[] };
  lists?: Record<string, DocsList>;
  tabs?: DocsTab[];
}

export type ImportedBlock =
  | { type: "heading1" | "heading2" | "paragraph" | "quote"; html: string }
  | { type: "bulletlist" | "numberlist"; items: { text: string; level: number }[] }
  | { type: "table"; rows: string[][] };

/** ドキュメントURL、または生のドキュメントIDを受け取り、IDを取り出す */
export function extractDocId(input: string): string | null {
  const trimmed = input.trim();
  const m = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{15,}$/.test(trimmed)) return trimmed;
  return null;
}

/** URLに含まれる ?tab=t.xxxx / &tab=t.xxxx からタブIDを取り出す(無ければnull) */
export function extractTabId(input: string): string | null {
  const m = input.trim().match(/[?&#]tab=([a-zA-Z0-9._-]+)/);
  return m ? m[1] : null;
}

/** タブを平坦なリストにする(子タブも含める) */
function flattenTabs(tabs: DocsTab[]): DocsTab[] {
  const out: DocsTab[] = [];
  for (const t of tabs) {
    out.push(t);
    if (t.childTabs && t.childTabs.length > 0) out.push(...flattenTabs(t.childTabs));
  }
  return out;
}

/**
 * ドキュメントから読み込む対象(タイトル・本文要素・リスト定義)を選び出す。
 * tabId が指定され、一致するタブがあればそれを使う。無ければ最初のタブ、
 * タブが無い旧来形式ならドキュメント直下の body を使う。
 */
export function selectTabContent(
  doc: DocsApiDocument,
  tabId: string | null
): { title: string; content: DocsStructuralElement[]; lists: Record<string, DocsList> } {
  const tabs = doc.tabs && doc.tabs.length > 0 ? flattenTabs(doc.tabs) : null;
  if (tabs) {
    const match = tabId ? tabs.find((t) => t.tabProperties?.tabId === tabId) : undefined;
    const tab = match ?? tabs[0];
    return {
      title: tab.tabProperties?.title || doc.title || "",
      content: tab.documentTab?.body?.content ?? [],
      lists: tab.documentTab?.lists ?? {},
    };
  }
  return { title: doc.title || "", content: doc.body?.content ?? [], lists: doc.lists ?? {} };
}

function paragraphPlainText(p: DocsParagraph): string {
  return (p.elements ?? [])
    .map((el) => el.textRun?.content ?? "")
    .join("")
    .replace(/\n+$/, "");
}

function paragraphHtml(p: DocsParagraph): string {
  return (p.elements ?? [])
    .map((el) => {
      const run = el.textRun;
      if (!run) return "";
      let text = escapeHtml(run.content.replace(/\n+$/, ""));
      if (!text) return "";
      if (run.textStyle?.bold) text = `<strong>${text}</strong>`;
      if (run.textStyle?.italic) text = `<em>${text}</em>`;
      return text;
    })
    .join("");
}

/** ordered(番号付き)リストかどうかを判定する。判定できない場合はfalse(箇条書き)扱い */
function isOrderedList(lists: Record<string, DocsList>, listId: string, nestingLevel: number): boolean {
  const level = lists[listId]?.listProperties?.nestingLevels?.[nestingLevel] ?? undefined;
  const glyphType = level?.glyphType;
  return !!glyphType && glyphType !== "GLYPH_TYPE_UNSPECIFIED";
}

function headingBlockType(namedStyleType: string | undefined): "heading1" | "heading2" | null {
  switch (namedStyleType) {
    case "TITLE":
    case "HEADING_1":
      return "heading1";
    case "SUBTITLE":
    case "HEADING_2":
    case "HEADING_3":
    case "HEADING_4":
    case "HEADING_5":
    case "HEADING_6":
      return "heading2";
    default:
      return null;
  }
}

/**
 * Docs APIのドキュメントを、Memomentoの新規ページ用データ(タイトル+ブロック列)に変換する。
 * tabId を指定すると、ドキュメントが複数タブを持つ場合にそのタブだけを取り込む
 * (未指定/一致しない場合は最初のタブ)。
 */
export function parseGoogleDoc(
  doc: DocsApiDocument,
  tabId: string | null = null
): { title: string; blocks: ImportedBlock[] } {
  const { title, content, lists } = selectTabContent(doc, tabId);
  const blocks: ImportedBlock[] = [];
  let listBuffer:
    | { type: "bulletlist" | "numberlist"; items: { text: string; level: number }[]; listId: string }
    | null = null;

  function flushList() {
    if (listBuffer && listBuffer.items.length > 0) {
      blocks.push({ type: listBuffer.type, items: listBuffer.items });
    }
    listBuffer = null;
  }

  for (const el of content) {
    if (el.paragraph) {
      const p = el.paragraph;
      const text = paragraphPlainText(p);

      if (p.bullet) {
        if (!text.trim()) continue;
        const nestingLevel = p.bullet.nestingLevel ?? 0;
        const type = isOrderedList(lists, p.bullet.listId, nestingLevel) ? "numberlist" : "bulletlist";
        if (!listBuffer || listBuffer.type !== type || listBuffer.listId !== p.bullet.listId) {
          flushList();
          listBuffer = { type, items: [], listId: p.bullet.listId };
        }
        listBuffer.items.push({ text: text.trim(), level: Math.min(Math.max(nestingLevel, 0), 5) });
        continue;
      }

      flushList();
      if (!text.trim()) continue;

      const headingType = headingBlockType(p.paragraphStyle?.namedStyleType);
      blocks.push({ type: headingType ?? "paragraph", html: paragraphHtml(p) });
    } else if (el.table) {
      flushList();
      const rows = (el.table.tableRows ?? []).map((row) =>
        (row.tableCells ?? []).map((cell) =>
          (cell.content ?? [])
            .map((c) => (c.paragraph ? paragraphPlainText(c.paragraph) : ""))
            .join(" ")
            .trim()
        )
      );
      if (rows.length > 0) blocks.push({ type: "table", rows });
    }
    // セクション区切り・目次など、それ以外の要素は無視する
  }
  flushList();

  return { title: title.trim() || "無題のページ", blocks };
}
