import { errorResponse, json } from "@/lib/api-helpers";
import { readEnv } from "@/lib/google";
import { createPage, ensureSchema, loadAll } from "@/lib/store";
import { nextOrderIndex } from "@/lib/tree";
import type { Page, PageWithBlocks } from "@/lib/types";

export const runtime = "edge";

/** 全ページ・全ブロックの取得(初回読み込み用) */
export async function GET() {
  try {
    const env = readEnv();
    await ensureSchema(env);
    const { pages, blocks } = await loadAll(env);
    const withBlocks: PageWithBlocks[] = pages.map((p) => ({
      ...p,
      blocks: blocks.filter((b) => b.pageId === p.id),
    }));
    return json({ pages: withBlocks });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 新規ページの作成 */
export async function POST(req: Request) {
  try {
    const env = readEnv();
    const body = (await req.json()) as {
      title?: string;
      parentId?: string | null;
      icon?: string;
    };
    const { pages } = await loadAll(env);
    const parentId = body.parentId ?? null;
    if (parentId !== null && !pages.some((p) => p.id === parentId)) {
      return json({ error: "親ページが存在しません" }, 404);
    }
    const ts = new Date().toISOString();
    const page: Page = {
      id: `p_${crypto.randomUUID()}`,
      title: body.title ?? "",
      parentId,
      orderIndex: nextOrderIndex(pages, parentId),
      icon: body.icon || "🗒️",
      tags: [],
      createdAt: ts,
      updatedAt: ts,
    };
    await createPage(env, page);
    return json({ page });
  } catch (e) {
    return errorResponse(e);
  }
}
