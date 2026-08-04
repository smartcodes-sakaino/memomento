import { errorResponse, json, validateBlocks } from "@/lib/api-helpers";
import { readEnv } from "@/lib/google";
import { loadAll, putBlocks } from "@/lib/store";
import type { Block } from "@/lib/types";

export const runtime = "edge";

type Params = { params: Promise<{ id: string }> };

/** ページ内ブロック一覧の一括保存 */
export async function PUT(req: Request, { params }: Params) {
  try {
    const env = readEnv();
    const { id } = await params;
    const body = (await req.json()) as { blocks?: unknown };

    const validationError = validateBlocks(body.blocks);
    if (validationError) return json({ error: validationError }, 400);

    const { pages } = await loadAll(env);
    if (!pages.some((p) => p.id === id)) {
      return json({ error: "ページが見つかりません" }, 404);
    }

    await putBlocks(env, id, body.blocks as Block[]);
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
