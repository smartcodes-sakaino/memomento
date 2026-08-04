import { errorResponse, json } from "@/lib/api-helpers";
import { readEnv } from "@/lib/google";
import { deletePageCascade, loadAll, updatePage } from "@/lib/store";
import { canMoveTo } from "@/lib/tree";
import { HOME_PAGE_ID, type Page } from "@/lib/types";

export const runtime = "edge";

type Params = { params: Promise<{ id: string }> };

/** ページ属性の更新(タイトル/親/並び順/アイコン/タグ) */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const env = readEnv();
    const { id } = await params;
    const body = (await req.json()) as Partial<
      Pick<Page, "title" | "parentId" | "orderIndex" | "icon" | "tags">
    >;

    if ("parentId" in body) {
      const { pages } = await loadAll(env);
      if (!canMoveTo(pages, id, body.parentId ?? null)) {
        return json({ error: "その位置には移動できません" }, 400);
      }
    }

    const page = await updatePage(env, id, body);
    if (!page) return json({ error: "ページが見つかりません" }, 404);
    return json({ page });
  } catch (e) {
    return errorResponse(e);
  }
}

/** ページの削除(子孫・所属ブロックも削除) */
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const env = readEnv();
    const { id } = await params;
    if (id === HOME_PAGE_ID) {
      return json({ error: "ホームページは削除できません" }, 400);
    }
    const deletedIds = await deletePageCascade(env, id);
    if (deletedIds.length === 0) {
      return json({ error: "ページが見つかりません" }, 404);
    }
    return json({ deletedIds });
  } catch (e) {
    return errorResponse(e);
  }
}
