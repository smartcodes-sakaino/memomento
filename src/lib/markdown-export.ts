/**
 * ページ・ブロックを1つのMarkdown文書に変換する。
 * NotebookLM等の外部ツールに読ませる「ソース」書き出し用。
 * Edge runtime(DOM無し)で動くよう、HTML→テキスト変換は正規表現で行う。
 *
 * ソースとしてのノイズを減らすため、アプリ内部の飾り(ページアイコン)や
 * システム的な表記(パンくず、区切り線)は出力しない。ページの親子関係は
 * 見出しレベル(##→###→####…)そのもので表現する。
 */

import { childrenOf } from "./tree";
import type {
  Block,
  ChecklistItem,
  ListItem,
  Page,
} from "./types";

const MAX_HEADING_LEVEL = 6;

function heading(level: number, text: string): string {
  const hashes = "#".repeat(Math.min(Math.max(level, 1), MAX_HEADING_LEVEL));
  return `${hashes} ${text}`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(
      /<span[^>]*class="callout-inline"[^>]*data-note="([^"]*)"[^>]*>([\s\S]*?)<\/span>/gi,
      "$2(補足: $1)"
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  const sep = header.map(() => "---");
  return [header, sep, ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/** pageLevel: このページの見出しレベル(##なら2)。ブロック内見出しはこれより深くする */
function renderBlock(b: Block, pageLevel: number): string {
  switch (b.type) {
    case "heading1":
      return heading(pageLevel + 1, htmlToText((b.content as { html: string }).html));
    case "heading2":
      return heading(pageLevel + 2, htmlToText((b.content as { html: string }).html));
    case "paragraph":
      return htmlToText((b.content as { html: string }).html);
    case "quote":
      return `> ${htmlToText((b.content as { html: string }).html)}`;
    case "code":
      return "```\n" + htmlToText((b.content as { html: string }).html) + "\n```";
    case "checklist":
      return (b.content as { items: ChecklistItem[] }).items
        .map((i) => `- [${i.done ? "x" : " "}] ${i.text}`)
        .join("\n");
    case "bulletlist":
      return (b.content as { items: ListItem[] }).items
        .map((i) => `- ${i.text}`)
        .join("\n");
    case "numberlist":
      return (b.content as { items: ListItem[] }).items
        .map((i, idx) => `${idx + 1}. ${i.text}`)
        .join("\n");
    case "table":
      return renderTable((b.content as { rows: string[][] }).rows);
    case "image": {
      const caption = (b.content as { src: string; caption: string }).caption;
      return caption ? `(画像: ${caption})` : "";
    }
    default:
      return "";
  }
}

/**
 * ページ群をMarkdown文書として書き出す。
 * includeIds を渡すと、そのページだけを本文として出力する(未選択の祖先は
 * 見出しを出さずスキップするが、選択されたページに辿り着くため子孫の探索は続ける)。
 * includeIds が未指定/nullなら全ページを出力する。
 */
export function renderPagesAsMarkdown(
  pages: Page[],
  blocks: Block[],
  includeIds?: Set<string> | null
): string {
  const blocksByPage = new Map<string, Block[]>();
  for (const b of blocks) {
    const arr = blocksByPage.get(b.pageId) ?? [];
    arr.push(b);
    blocksByPage.set(b.pageId, arr);
  }
  for (const arr of blocksByPage.values()) {
    arr.sort((a, c) => a.orderIndex - c.orderIndex);
  }

  const lines: string[] = [];
  let emitted = 0;

  function visit(page: Page, depth: number) {
    const title = page.title || "無題のページ";
    const level = Math.min(2 + depth, MAX_HEADING_LEVEL);

    if (!includeIds || includeIds.has(page.id)) {
      lines.push(heading(level, title));
      if (page.tags.length > 0) lines.push(`タグ: ${page.tags.map((t) => `#${t}`).join(" ")}`);
      lines.push("");

      for (const b of blocksByPage.get(page.id) ?? []) {
        const text = renderBlock(b, level);
        if (text) lines.push(text, "");
      }
      emitted++;
    }

    // 選択されていないページの配下に選択済みページがあるかもしれないため、探索は続ける
    for (const child of childrenOf(pages, page.id)) {
      visit(child, depth + 1);
    }
  }

  for (const root of childrenOf(pages, null)) {
    visit(root, 0);
  }

  if (emitted === 0) return "(選択されたページに内容がありません)";

  return lines.join("\n").trim();
}
