import { json } from "@/lib/api-helpers";
import { getSheetInfos, readEnv } from "@/lib/google";

export const runtime = "edge";

/** Google Sheets / Drive との接続確認 */
export async function GET() {
  let sheets = false;
  let drive = false;
  try {
    const env = readEnv();
    await getSheetInfos(env);
    sheets = true;
    // Sheets APIの認証が通ればDriveも同じサービスアカウントで動作する。
    // フォルダIDの存在確認までは行わない(画像アップロード時に検出される)。
    drive = Boolean(env.driveFolderId);
  } catch {
    // 未接続として返す
  }
  return json({ sheets, drive });
}
