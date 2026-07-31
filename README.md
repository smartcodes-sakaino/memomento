# Memomento

日々の小さな瞬間をメモに。

個人用のメモ・学習ノートアプリ。Notion風のブロックエディタとwikiリンクを備え、データはGoogleスプレッドシート、画像はGoogle Driveに保存する。

## 技術スタック

- Next.js (React) + TypeScript
- Cloudflare Pages (`@cloudflare/next-on-pages`)
- データストア: Google スプレッドシート (Sheets API)
- 画像: Google Drive (Drive API)
- 認証: サービスアカウント (アプリ利用者のログインは不要)

## 開発

```bash
npm ci
# .dev.vars.example をコピーして .dev.vars を作成し、各値を設定する
npm run dev
```

## 環境変数

| 変数名 | 内容 |
|---|---|
| GOOGLE_SERVICE_ACCOUNT_EMAIL | サービスアカウントのメールアドレス |
| GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY | サービスアカウントの秘密鍵 (PEM) |
| GOOGLE_SHEET_ID | データ保存用スプレッドシートのID |
| GOOGLE_DRIVE_FOLDER_ID | 画像保存用DriveフォルダのID |

設計書一式はGoogle Driveの「Memomento」フォルダを参照。
