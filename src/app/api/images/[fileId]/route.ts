import { errorResponse } from "@/lib/api-helpers";
import { downloadDriveFile, readEnv } from "@/lib/google";

export const runtime = "edge";

type Params = { params: Promise<{ fileId: string }> };

/** Drive上の画像を(非公開のまま)プロキシ配信する */
export async function GET(_req: Request, { params }: Params) {
  try {
    const env = readEnv();
    const { fileId } = await params;
    const upstream = await downloadDriveFile(env, fileId);
    return new Response(upstream.body, {
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/octet-stream",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
