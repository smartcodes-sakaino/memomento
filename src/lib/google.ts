/**
 * Google API クライアント (Cloudflare Workers / Edge runtime 対応)
 *
 * googleapis 等の Node.js 専用ライブラリは Workers runtime で動かないため、
 * サービスアカウントの JWT 署名を Web Crypto API で自前実装し、
 * Sheets / Drive へは REST (fetch) で直接アクセスする。
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
  // Googleドキュメントの取り込み機能用。書き込みは引き続き drive.file (アプリが作成した
  // ファイルのみ)に限定されており、これは「リンクを知っている全員」等で共有された
  // 既存ドキュメントを読み取るためだけに追加している
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

export interface GoogleEnv {
  serviceAccountEmail: string;
  privateKeyPem: string;
  sheetId: string;
  driveFolderId: string;
  /** NotebookLM用ドキュメントの保存先。画像フォルダとは別の共有ドライブ内フォルダを想定 */
  notebookFolderId: string;
}

export function readEnv(): GoogleEnv {
  const {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: email,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: key,
    GOOGLE_SHEET_ID: sheetId,
    GOOGLE_DRIVE_FOLDER_ID: folderId,
    GOOGLE_NOTEBOOKLM_FOLDER_ID: notebookFolderId,
  } = process.env;
  if (!email || !key || !sheetId || !folderId) {
    throw new GoogleApiError(
      "環境変数が未設定です (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY / GOOGLE_SHEET_ID / GOOGLE_DRIVE_FOLDER_ID)",
      500
    );
  }
  // 環境変数では改行が \n として渡されるため復元する
  return {
    serviceAccountEmail: email,
    privateKeyPem: key.replace(/\\n/g, "\n"),
    sheetId,
    driveFolderId: folderId,
    // 未設定の場合は画像フォルダにフォールバックする(設定必須にはしない)
    notebookFolderId: notebookFolderId || folderId,
  };
}

export class GoogleApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "GoogleApiError";
  }
}

function base64url(data: Uint8Array | string): string {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// アクセストークンは約1時間有効なため、モジュールスコープでキャッシュする
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(env: GoogleEnv): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: env.serviceAccountEmail,
      scope: SCOPES,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64url(new Uint8Array(signature))}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new GoogleApiError(
      `Googleアクセストークンの取得に失敗しました (${res.status})`,
      502
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

async function googleFetch(
  env: GoogleEnv,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getAccessToken(env);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GoogleApiError(
      `Google APIエラー (${res.status}): ${body.slice(0, 300)}`,
      res.status === 401 || res.status === 403 ? 502 : res.status
    );
  }
  return res;
}

// ---------- Sheets ----------

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export interface SheetInfo {
  sheetId: number;
  title: string;
}

export async function getSheetInfos(env: GoogleEnv): Promise<SheetInfo[]> {
  const res = await googleFetch(
    env,
    `${SHEETS_BASE}/${env.sheetId}?fields=sheets(properties(sheetId,title))`
  );
  const json = (await res.json()) as {
    sheets?: { properties: { sheetId: number; title: string } }[];
  };
  return (json.sheets ?? []).map((s) => s.properties);
}

export async function batchUpdateSpreadsheet(
  env: GoogleEnv,
  requests: unknown[]
): Promise<void> {
  await googleFetch(env, `${SHEETS_BASE}/${env.sheetId}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
}

export async function getValues(
  env: GoogleEnv,
  ranges: string[]
): Promise<string[][][]> {
  const params = new URLSearchParams();
  for (const r of ranges) params.append("ranges", r);
  params.set("valueRenderOption", "UNFORMATTED_VALUE");
  const res = await googleFetch(
    env,
    `${SHEETS_BASE}/${env.sheetId}/values:batchGet?${params}`
  );
  const json = (await res.json()) as {
    valueRanges?: { values?: unknown[][] }[];
  };
  return (json.valueRanges ?? []).map((vr) =>
    (vr.values ?? []).map((row) => row.map((c) => String(c ?? "")))
  );
}

export async function updateValues(
  env: GoogleEnv,
  range: string,
  values: string[][]
): Promise<void> {
  await googleFetch(
    env,
    `${SHEETS_BASE}/${env.sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
}

export async function appendValues(
  env: GoogleEnv,
  range: string,
  values: string[][]
): Promise<void> {
  await googleFetch(
    env,
    `${SHEETS_BASE}/${env.sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
}

// ---------- Drive ----------

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export async function uploadImageToDrive(
  env: GoogleEnv,
  filename: string,
  mimeType: string,
  data: ArrayBuffer
): Promise<{ fileId: string }> {
  const boundary = `memomento-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name: filename,
    parents: [env.driveFolderId],
  });

  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + data.byteLength + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(data), head.length);
  body.set(tail, head.length + data.byteLength);

  const res = await googleFetch(
    env,
    // supportsAllDrives: 共有ドライブ配下のフォルダへのアップロードに必要
    // (サービスアカウントは自身の保存容量を持たないため、保存先は共有ドライブとする)
    `${DRIVE_UPLOAD}?uploadType=multipart&fields=id&supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  const json = (await res.json()) as { id: string };
  return { fileId: json.id };
}

const DOCS_BASE = "https://docs.googleapis.com/v1/documents";

/**
 * テキストを新規のGoogleドキュメントとしてDriveフォルダに作成する。
 * (NotebookLM等の外部ツール用ソースの書き出し。常に新規作成し、上書きはしない
 *  — 選択内容ごとに別ファイルとして永続的に残すため)
 *
 * Drive APIの「テキストファイルをアップロードしてGoogleドキュメントに変換」経路は
 * 絵文字などの非ASCII文字を正しく扱えないことがあるため、空のドキュメントを作成した後
 * Docs APIのbatchUpdate(JSON経由)で本文を流し込む方式にしている。JSON文字列としての
 * 送信は他のAPI(ページ更新など)と同じ経路なので、日本語・絵文字とも正しく保存される。
 */
export async function createDriveDoc(
  env: GoogleEnv,
  name: string,
  text: string
): Promise<{ fileId: string; url: string }> {
  const createRes = await googleFetch(
    env,
    `${DRIVE_BASE}/files?fields=id,webViewLink&supportsAllDrives=true`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        name,
        parents: [env.notebookFolderId],
        mimeType: "application/vnd.google-apps.document",
      }),
    }
  );
  const created = (await createRes.json()) as { id: string; webViewLink: string };

  if (text) {
    await googleFetch(env, `${DOCS_BASE}/${created.id}:batchUpdate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: 1 }, text } }],
      }),
    });
  }

  return { fileId: created.id, url: created.webViewLink };
}

/** Googleドキュメントの内容を取得する(取り込み機能用)。タブ機能を使ったドキュメントにも対応する */
export async function getGoogleDoc(env: GoogleEnv, docId: string): Promise<unknown> {
  const res = await googleFetch(
    env,
    `${DOCS_BASE}/${encodeURIComponent(docId)}?includeTabsContent=true`
  );
  return res.json();
}

export async function downloadDriveFile(
  env: GoogleEnv,
  fileId: string
): Promise<Response> {
  return googleFetch(
    env,
    `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`
  );
}
