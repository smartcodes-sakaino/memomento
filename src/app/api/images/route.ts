import { errorResponse, json } from "@/lib/api-helpers";
import { readEnv, uploadImageToDrive } from "@/lib/google";

export const runtime = "edge";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

/** 画像をGoogle Driveにアップロードし、アプリ内で使うURLを返す */
export async function POST(req: Request) {
  try {
    const env = readEnv();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return json({ error: "ファイルが指定されていません" }, 400);
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return json({ error: "対応していないファイル形式です(PNG/JPEG/GIF/WebP/SVGのみ)" }, 400);
    }
    if (file.size > MAX_SIZE) {
      return json({ error: "画像サイズは10MB以下にしてください" }, 400);
    }
    const { fileId } = await uploadImageToDrive(
      env,
      file.name || `image-${Date.now()}`,
      file.type,
      await file.arrayBuffer()
    );
    // Driveのファイルは非公開のまま、アプリのAPI経由で配信する
    return json({ url: `/api/images/${fileId}` });
  } catch (e) {
    return errorResponse(e);
  }
}
