# Commons（仮称）

中央集権型の、コミュニティ開発OSS SNSです。X型のわかりやすい操作感を保ちながら、利用者が機能提案、設計議論、テスト、翻訳、実装に参加できるプロダクトを目指します。

> 現在は公開開発前のUIプロトタイプです。名称・仕様・デザインは今後変更されます。

## 現在できること

- レスポンシブな3カラム／モバイルタイムライン
- 280文字までのローカル投稿
- いいね、リポスト、ブックマーク
- 投稿のリアルタイム検索
- おすすめ／フォロー中タブの切り替え
- コミュニティ開発への導線

現段階の画面操作はブラウザを更新すると消えます。D1の初期スキーマとサンプルデータは実装済みで、次のマイルストーンで認証と画面操作をD1へ接続します。

## ローカル起動

Node.js 22以降を使用してください。

```bash
npm install
npm run dev
```

ターミナルに表示されるローカルURL（通常は `http://localhost:5173`）をブラウザで開きます。

現段階のUIプロトタイプはD1未接続のため、マイグレーションは不要です。`npm run db:migrate:local` は、`wrangler.jsonc` のコメント化された `d1_databases` Bindingsを有効にした後に実行できるようになります。

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

初回はUIとWorkerだけをデプロイできます。Cloudflare Dashboardの **Workers & Pages** から **Create application** → **Import a repository** を選び、このリポジトリを接続してください。

- Worker name: `commons-sns`
- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

初回公開後にD1、R2、Queuesを作成し、`wrangler.jsonc`内のコメント化されたBindingsを有効にします。

## コントリビューション

現在は初期設計中です。参加ルールは [CONTRIBUTING.md](./CONTRIBUTING.md)、意思決定の原則は [GOVERNANCE.md](./GOVERNANCE.md) を参照してください。

## ライセンス

GNU Affero General Public License v3.0 only（AGPL-3.0-only）で公開しています。詳しくは [LICENSE](./LICENSE) を参照してください。
