/** バックエンドAPIの薄いクライアント。失敗時は例外を投げる */

import type { Page, PageWithBlocks } from "@/lib/types";
import type { ClientBlock } from "./model";
import { blocksToServer } from "./model";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `APIエラー (${res.status})`);
  }
  return body;
}

export function apiFetchAll(): Promise<{ pages: PageWithBlocks[] }> {
  return request("/api/pages");
}

export function apiCreatePage(input: {
  title: string;
  parentId: string | null;
  icon?: string;
}): Promise<{ page: Page }> {
  return request("/api/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function apiPatchPage(
  id: string,
  patch: Partial<Pick<Page, "title" | "parentId" | "orderIndex" | "icon" | "tags">>
): Promise<{ page: Page }> {
  return request(`/api/pages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function apiDeletePage(id: string): Promise<{ deletedIds: string[] }> {
  return request(`/api/pages/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function apiPutBlocks(
  pageId: string,
  blocks: ClientBlock[]
): Promise<{ ok: boolean }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/blocks`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks: blocksToServer(pageId, blocks) }),
  });
}

export async function apiUploadImage(file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.append("file", file);
  return request("/api/images", { method: "POST", body: form });
}

export function apiExport(): Promise<{ url: string }> {
  return request("/api/export");
}

export function apiHealth(): Promise<{ sheets: boolean; drive: boolean }> {
  return request("/api/health");
}
