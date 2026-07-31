/**
 * wikiリンクはHTML内に <a class="wikilink" data-page-id="..."> として埋め込む。
 * 表示テキストはID参照で解決するため、リンク先ページの改名に自動追従する。
 */

const LINK_RE =
  /(<a\b[^>]*\bdata-page-id="([^"]+)"[^>]*>)([\s\S]*?)(<\/a>)/g;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML文字列からリンク先ページIDを出現順に抽出する */
export function extractLinkedPageIds(html: string): string[] {
  const ids: string[] = [];
  for (const m of html.matchAll(LINK_RE)) {
    ids.push(m[2]);
  }
  return ids;
}

/**
 * リンクの表示テキストを最新のページタイトルに同期する。
 * titles に存在しないIDのリンクはそのまま残す。
 */
export function syncLinkLabels(
  html: string,
  titles: Map<string, string>
): string {
  return html.replace(LINK_RE, (whole, open, pageId, _label, close) => {
    const title = titles.get(pageId);
    if (title === undefined) return whole;
    return `${open}${escapeHtml(title)}${close}`;
  });
}
