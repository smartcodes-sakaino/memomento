import { errorResponse } from "@/lib/api-helpers";
import { readEnv } from "@/lib/google";
import { loadAll } from "@/lib/store";

export const runtime = "edge";

/**
 * 全データ(ページ+ブロック)をJSONファイルとしてダウンロードさせる。
 * Driveの権限を drive.file (アプリが作成したファイルのみ) に絞っているため、
 * スプレッドシート本体のDriveコピーは行わず、ファイルダウンロード方式とする。
 */
export async function GET() {
  try {
    const env = readEnv();
    const { pages, blocks } = await loadAll(env);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    const body = JSON.stringify(
      { exportedAt: new Date().toISOString(), pages, blocks },
      null,
      2
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="memomento-backup-${stamp}.json"`,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
