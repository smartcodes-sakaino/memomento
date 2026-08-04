import { GoogleApiError } from "./google";
import { BLOCK_TYPES, type Block, type BlockType } from "./types";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof GoogleApiError) {
    return json({ error: e.message }, e.status);
  }
  const message = e instanceof Error ? e.message : "不明なエラーが発生しました";
  return json({ error: message }, 500);
}

/** クライアントから受け取ったブロック配列を検証する。不正ならエラーメッセージを返す */
export function validateBlocks(input: unknown): string | null {
  if (!Array.isArray(input)) return "blocksは配列である必要があります";
  for (const b of input) {
    if (typeof b !== "object" || b === null) return "不正なブロックが含まれています";
    const block = b as Partial<Block>;
    if (typeof block.id !== "string" || block.id === "")
      return "ブロックにidがありません";
    if (!BLOCK_TYPES.includes(block.type as BlockType))
      return `未定義のブロック種別です: ${String(block.type)}`;
    if (typeof block.content !== "object" || block.content === null)
      return "ブロックのcontentが不正です";
  }
  return null;
}
