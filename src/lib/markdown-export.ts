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

/** 表セル1つ分のHTMLをMarkdownテキストに変換する(改行・パイプはテーブル記法を壊すため潰す) */
function tableCellToText(cellHtml: string): string {
  return htmlToText(cellHtml).replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
}

/**
 * <table>の中身をMarkdownの表記法に変換する。
 * Googleドキュメントなどからの貼り付けで、本文(paragraph等)のHTMLに
 * 生の<table>がそのまま埋め込まれることがあり、素通しで文字列除去すると
 * セルの中身が区切りなく連結されてしまうため、専用に変換する。
 */
function tableHtmlToMarkdown(tableHtml: string): string {
  const rows = Array.from(tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)).map((m) =>
    Array.from(m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) =>
      tableCellToText(c[1])
    )
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => {
    const copy = r.slice();
    while (copy.length < width) copy.push("");
    return copy;
  });
  const [header, ...body] = padded;
  const sep = header.map(() => "---");
  return [header, sep, ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

export function htmlToText(html: string): string {
  return html
    // 本文中に生の<table>が埋め込まれている場合(Googleドキュメント等からの貼り付け)、
    // 他のタグ除去より先にMarkdownの表として変換しておく
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) => {
      const md = tableHtmlToMarkdown(inner);
      return md ? `\n\n${md}\n\n` : "";
    })
    // 外部リンクはURLに意味があるため、Markdownのリンク記法として残す
    .replace(
      /<a\b[^>]*class="ext-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      "[$2]($1)"
    )
    .replace(
      /<a\b[^>]*href="([^"]*)"[^>]*class="ext-link"[^>]*>([\s\S]*?)<\/a>/gi,
      "[$2]($1)"
    )
    // それ以外のリンク(wikiリンク)は表示テキストだけを残す
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

/** 階層(level)付きの項目をMarkdownの入れ子リストとして書き出す。番号は階層ごとに振り直す */
function renderOutlineItems(items: { text: string; level?: number }[], ordered: boolean): string {
  const counters = [0, 0, 0, 0, 0, 0];
  return items
    .map((it) => {
      const level = Math.min(Math.max(it.level ?? 0, 0), counters.length - 1);
      counters[level] += 1;
      for (let d = level + 1; d < counters.length; d++) counters[d] = 0;
      const marker = ordered ? `${counters[level]}.` : "-";
      return `${"  ".repeat(level)}${marker} ${htmlToText(it.text)}`;
    })
    .join("\n");
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
        .map(
          (i) =>
            `${"  ".repeat(Math.min(Math.max(i.level ?? 0, 0), 5))}- [${i.done ? "x" : " "}] ${htmlToText(i.text)}`
        )
        .join("\n");
    case "bulletlist":
      return renderOutlineItems((b.content as { items: ListItem[] }).items, false);
    case "numberlist":
      return renderOutlineItems((b.content as { items: ListItem[] }).items, true);
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
