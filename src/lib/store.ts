/**
 * スプレッドシートを台帳として使うリポジトリ層。
 * シート構成は「DB設計書」に準拠する:
 *   Pages:  id | title | parent_id | order_index | icon | tags | created_at | updated_at
 *   Blocks: id | page_id | order_index | type | content | created_at | updated_at
 */

import {
  appendValues,
  batchUpdateSpreadsheet,
  clearValues,
  getSheetInfos,
  getValues,
  updateValues,
  type GoogleEnv,
} from "./google";
import {
  BLOCKS_HEADER,
  PAGES_HEADER,
  blockToRow,
  pageToRow,
  rowToBlock,
  rowToPage,
} from "./sheetcodec";
import { collectDescendantIds } from "./tree";
import { HOME_PAGE_ID, type Block, type Page } from "./types";

const PAGES_SHEET = "Pages";
const BLOCKS_SHEET = "Blocks";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * シート構成を保証する(初回起動時に自動セットアップ)。
 * - Pages/Blocksシートがなければ作成し、ヘッダー行を書き込む
 * - CSVインポート由来の既存シート(ヘッダーがPages相当)があればPagesに改名して流用する
 * - ホームページの行がなければ作成する
 */
export async function ensureSchema(env: GoogleEnv): Promise<void> {
  const infos = await getSheetInfos(env);
  const titles = new Set(infos.map((i) => i.title));
  const requests: unknown[] = [];

  if (!titles.has(PAGES_SHEET)) {
    const candidate = await findPagesLikeSheet(env, infos.map((i) => i.title));
    if (candidate) {
      const info = infos.find((i) => i.title === candidate)!;
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: info.sheetId, title: PAGES_SHEET },
          fields: "title",
        },
      });
    } else {
      requests.push({ addSheet: { properties: { title: PAGES_SHEET } } });
    }
  }
  if (!titles.has(BLOCKS_SHEET)) {
    requests.push({ addSheet: { properties: { title: BLOCKS_SHEET } } });
  }
  if (requests.length > 0) {
    await batchUpdateSpreadsheet(env, requests);
  }

  await updateValues(env, `${PAGES_SHEET}!A1:H1`, [[...PAGES_HEADER]]);
  await updateValues(env, `${BLOCKS_SHEET}!A1:G1`, [[...BLOCKS_HEADER]]);

  // ホームページの存在保証
  const [pageRows] = await getValues(env, [`${PAGES_SHEET}!A2:H`]);
  const hasHome = (pageRows ?? []).some((r) => r[0] === HOME_PAGE_ID);
  if (!hasHome) {
    const ts = nowIso();
    const home: Page = {
      id: HOME_PAGE_ID,
      title: "ホーム",
      parentId: null,
      orderIndex: 0,
      icon: "🏠",
      tags: [],
      createdAt: ts,
      updatedAt: ts,
    };
    await appendValues(env, `${PAGES_SHEET}!A1`, [pageToRow(home)]);
  }
}

/** CSVインポートで作られた、Pagesと同じヘッダーを持つシートを探す */
async function findPagesLikeSheet(
  env: GoogleEnv,
  titles: string[]
): Promise<string | null> {
  for (const title of titles) {
    try {
      const [rows] = await getValues(env, [`${title}!A1:H1`]);
      const header = rows?.[0] ?? [];
      if (header.join(",") === PAGES_HEADER.join(",")) return title;
    } catch {
      // 読めないシートは無視
    }
  }
  return null;
}

export interface AllData {
  pages: Page[];
  blocks: Block[];
}

export async function loadAll(env: GoogleEnv): Promise<AllData> {
  const [pageRows, blockRows] = await getValues(env, [
    `${PAGES_SHEET}!A2:H`,
    `${BLOCKS_SHEET}!A2:G`,
  ]);
  const pages = (pageRows ?? [])
    .filter((r) => r[0])
    .map(rowToPage);
  const blocks = (blockRows ?? [])
    .map(rowToBlock)
    .filter((b): b is Block => b !== null)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  return { pages, blocks };
}

export async function createPage(env: GoogleEnv, page: Page): Promise<void> {
  await appendValues(env, `${PAGES_SHEET}!A1`, [pageToRow(page)]);
}

export async function updatePage(
  env: GoogleEnv,
  id: string,
  patch: Partial<Pick<Page, "title" | "parentId" | "orderIndex" | "icon" | "tags">>
): Promise<Page | null> {
  const [pageRows] = await getValues(env, [`${PAGES_SHEET}!A2:H`]);
  const rows = pageRows ?? [];
  const idx = rows.findIndex((r) => r[0] === id);
  if (idx === -1) return null;

  const page = rowToPage(rows[idx]);
  const updated: Page = {
    ...page,
    ...("title" in patch ? { title: patch.title ?? page.title } : {}),
    ...("parentId" in patch ? { parentId: patch.parentId ?? null } : {}),
    ...("orderIndex" in patch && patch.orderIndex !== undefined
      ? { orderIndex: patch.orderIndex }
      : {}),
    ...("icon" in patch ? { icon: patch.icon ?? page.icon } : {}),
    ...("tags" in patch ? { tags: patch.tags ?? page.tags } : {}),
    updatedAt: nowIso(),
  };
  await updateValues(env, `${PAGES_SHEET}!A${idx + 2}:H${idx + 2}`, [
    pageToRow(updated),
  ]);
  return updated;
}

/** ページと全子孫、所属ブロックを削除する。削除したページIDの一覧を返す */
export async function deletePageCascade(
  env: GoogleEnv,
  id: string
): Promise<string[]> {
  const { pages, blocks } = await loadAll(env);
  const target = pages.find((p) => p.id === id);
  if (!target) return [];

  const deleteIds = new Set(collectDescendantIds(pages, id));
  const keptPages = pages.filter((p) => !deleteIds.has(p.id));
  const keptBlocks = blocks.filter((b) => !deleteIds.has(b.pageId));

  await clearValues(env, `${PAGES_SHEET}!A2:H`);
  if (keptPages.length > 0) {
    await updateValues(env, `${PAGES_SHEET}!A2`, keptPages.map(pageToRow));
  }
  await clearValues(env, `${BLOCKS_SHEET}!A2:G`);
  if (keptBlocks.length > 0) {
    await updateValues(env, `${BLOCKS_SHEET}!A2`, keptBlocks.map(blockToRow));
  }
  return [...deleteIds];
}

/** ページ内のブロック一覧をまとめて置き換える */
export async function putBlocks(
  env: GoogleEnv,
  pageId: string,
  blocks: Block[]
): Promise<void> {
  const [blockRows] = await getValues(env, [`${BLOCKS_SHEET}!A2:G`]);
  const others = (blockRows ?? [])
    .map(rowToBlock)
    .filter((b): b is Block => b !== null && b.pageId !== pageId);

  const normalized = blocks.map((b, i) => ({
    ...b,
    pageId,
    orderIndex: i,
    updatedAt: nowIso(),
  }));

  const all = [...others, ...normalized];
  await clearValues(env, `${BLOCKS_SHEET}!A2:G`);
  if (all.length > 0) {
    await updateValues(env, `${BLOCKS_SHEET}!A2`, all.map(blockToRow));
  }
}
