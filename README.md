# Commons（仮称）

中央集権型の、コミュニティ開発OSS SNSです。X型のわかりやすい操作感を保ちながら、利用者が機能提案、設計議論、テスト、翻訳、実装に参加できるプロダクトを目指します。

> 現在は初期MVPです。名称・仕様・デザインは今後変更されます。

## 現在できること

- レスポンシブな3カラム／モバイルタイムライン
- ユーザー登録、ログイン、ログアウト
- 280文字までのD1永続投稿と本人による削除
- D1に保存されるいいね、リポスト、ブックマーク
- 保存した投稿のブックマーク一覧表示と解除
- 投稿のリアルタイム検索
- おすすめ／フォロー中タブの切り替え
- コミュニティ開発への導線

画像投稿、返信、フォロー、通知は今後のマイルストーンで実装します。

## ローカル起動

Node.js 22以降を使用してください。

```bash
npm install
npm run db:migrate:local
npm run dev
```

ターミナルに表示されるローカルURL（通常は `http://localhost:5173`）をブラウザで開きます。

## 開発方針

1. 公式サービスの実際のコードを公開する
2. 意思決定とロードマップを可能な限り公開する
3. 一般利用者にも、コード以外の参加手段を用意する
4. セキュリティ、プライバシー、運営可能性についてはメンテナーが最終判断する
5. 汎用SNSエンジン化は、公式版が安定してから進める

## 技術構成

- React Router 8 / React 19 / TypeScript
- Cloudflare Workers + Cloudflare Vite plugin
- D1（ユーザー、投稿、フォロー、リアクション）
- R2（画像・動画）
- Queues（通知、メディア処理、非同期集計）

詳しい役割分担は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照してください。

## Cloudflareへデプロイ

Cloudflare Dashboardの **Workers & Pages** から **Create application** → **Import a repository** を選び、このリポジトリを接続してください。

- Worker name: `commons-sns`
- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

D1の本番マイグレーションは、デプロイ前に `npm run db:migrate:remote` で適用してください。R2とQueuesはメディア・通知機能を実装する段階で接続します。

Cloudflare Dashboardのみで初期化する場合は、D1のConsoleで [`scripts/production-bootstrap.sql`](./scripts/production-bootstrap.sql) を一度実行してください。このSQLは初期スキーマとWranglerのマイグレーション履歴を同時に作成します。

## コントリビューション

現在は初期設計中です。参加ルールは [CONTRIBUTING.md](./CONTRIBUTING.md)、意思決定の原則は [GOVERNANCE.md](./GOVERNANCE.md) を参照してください。

## ライセンス

GNU Affero General Public License v3.0 only（AGPL-3.0-only）で公開しています。詳しくは [LICENSE](./LICENSE) を参照してください。
