import { errorResponse, json } from "@/lib/api-helpers";
import { copySpreadsheet, readEnv } from "@/lib/google";

export const runtime = "edge";

/** スプレッドシートのコピーを作成してバックアップとする */
export async function GET() {
  try {
    const env = readEnv();
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, "-")
      .slice(0, 16);
    const { url } = await copySpreadsheet(env, `Memomento_DB_backup_${stamp}`);
    return json({ url });
  } catch (e) {
    return errorResponse(e);
  }
}
