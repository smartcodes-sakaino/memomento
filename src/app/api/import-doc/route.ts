import { errorResponse, json } from "@/lib/api-helpers";
import {
  extractDocId,
  extractTabId,
  parseGoogleDoc,
  type DocsApiDocument,
} from "@/lib/docs-import";
import { GoogleApiError, getGoogleDoc, readEnv } from "@/lib/google";
import { createPage, ensureSchema, loadAll, putBlocks } from "@/lib/store";
import { nextOrderIndex } from "@/lib/tree";
import type { Block, BlockType } from "@/lib/types";

export const runtime = "edge";

/** 既存のGoogleドキュメントを新規ページとして取り込む(見出し・リスト・表を保つ) */
export async function POST(req: Request) {
  try {
    const env = readEnv();
    const body = (await req.json()) as {
      docUrlOrId?: unknown;
      parentId?: unknown;
      title?: unknown;
    };

    if (typeof body.docUrlOrId !== "string" || !body.docUrlOrId.trim()) {
      return json({ error: "GoogleドキュメントのURLまたはIDを入力してください" }, 400);
    }
    const docId = extractDocId(body.docUrlOrId);
    if (!docId) {
      return json({ error: "URLまたはIDの形式が正しくありません" }, 400);
    }
    const tabId = extractTabId(body.docUrlOrId);
    const parentId = typeof body.parentId === "string" ? body.parentId : null;

    await ensureSchema(env);
    const { pages } = await loadAll(env);
    if (parentId && !pages.some((p) => p.id === parentId)) {
      return json({ error: "親ページが見つかりません" }, 404);
    }

    let doc: DocsApiDocument;
    try {
      doc = (await getGoogleDoc(env, docId)) as DocsApiDocument;
    } catch (e) {
      if (e instanceof GoogleApiError && (e.status === 404 || e.status === 502)) {
        return json(
          {
            error:
              "ドキュメントにアクセスできませんでした。共有設定(リンクを知っている全員が閲覧可、またはサービスアカウントへの共有)をご確認ください",
          },
          404
        );
      }
      throw e;
    }

    const parsed = parseGoogleDoc(doc, tabId);
    const title =
      typeof body.title === "string" && body.title.trim() ? body.title.trim() : parsed.title;

    const ts = new Date().toISOString();
    const page = {
      id: `p_${crypto.randomUUID()}`,
      title,
      parentId,
      orderIndex: nextOrderIndex(pages, parentId),
      icon: "📄",
      tags: [],
      createdAt: ts,
      updatedAt: ts,
    };
    await createPage(env, page);

    const blocks: Block[] = parsed.blocks.map((ib, i) => {
      let content: Block["content"];
      switch (ib.type) {
        case "table":
          content = { rows: ib.rows };
          break;
        case "bulletlist":
        case "numberlist":
          content = { items: ib.items.map((it) => ({ id: `i_${crypto.randomUUID()}`, text: it.text })) };
          break;
        default:
          content = { html: ib.html };
      }
      return {
        id: `b_${crypto.randomUUID()}`,
        pageId: page.id,
        orderIndex: i,
        type: ib.type as BlockType,
        content,
        createdAt: ts,
        updatedAt: ts,
      };
    });
    if (blocks.length > 0) await putBlocks(env, page.id, blocks);

    return json({ page: { ...page, blocks } });
  } catch (e) {
    return errorResponse(e);
  }
}
