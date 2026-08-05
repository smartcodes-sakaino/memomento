import { errorResponse, json } from "@/lib/api-helpers";
import { createDriveDoc, readEnv } from "@/lib/google";
import { renderPagesAsMarkdown } from "@/lib/markdown-export";
import { ensureSchema, loadAll } from "@/lib/store";

export const runtime = "edge";

function defaultDocName(titles: string[]): string {
  const shown = titles.slice(0, 3).join("、");
  const suffix = titles.length > 3 ? " ほか" : "";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `Memomento - ${shown}${suffix} - ${stamp}`;
}

/** 選択したページを整形し、新規のGoogleドキュメントとして書き出す(NotebookLM用ソース) */
export async function POST(req: Request) {
  try {
    const env = readEnv();
    const body = (await req.json()) as { pageIds?: unknown; title?: unknown };

    if (!Array.isArray(body.pageIds) || body.pageIds.length === 0) {
      return json({ error: "書き出すページを1つ以上選択してください" }, 400);
    }
    if (!body.pageIds.every((id) => typeof id === "string")) {
      return json({ error: "pageIdsの形式が不正です" }, 400);
    }
    const pageIds = body.pageIds as string[];

    await ensureSchema(env);
    const { pages, blocks } = await loadAll(env);

    const selected = pages.filter((p) => pageIds.includes(p.id));
    if (selected.length === 0) {
      return json({ error: "指定されたページが見つかりません" }, 404);
    }

    const markdown = renderPagesAsMarkdown(pages, blocks, new Set(pageIds));
    const name =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : defaultDocName(selected.map((p) => p.title || "無題のページ"));

    const { url } = await createDriveDoc(env, name, markdown);
    return json({ url, name });
  } catch (e) {
    return errorResponse(e);
  }
}
