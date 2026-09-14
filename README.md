# natsumi

Pi Coding Agent を使う個人アシスタント。現在はサーバー基盤（設定の検証、data directory の初期化、
二重起動の拒否、状態 DB の migration、専用の Pi 状態領域、コンテナ）と、Pi SDK の隔離検証ハーネスを提供しています。
クライアント認証と接続、会話、Mac UI、Google/Wiki 連携は後続の実装です。

Node.js 24.12.0 以降を使用します。通常の検証は外部認証・ネットワーク接続を必要としません
（初回の npm 依存取得を除く）。Pi は `@earendil-works/pi-coding-agent` の SDK を npm 依存として固定しています。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` は Node 標準 test runner で、サーバー基盤の試験と、モデル応答を合成 stream に差し替えた Pi SDK の fixture を実行します。
build 結果は `dist/` に生成されます。実際のモデルへ接続する検証は `npm run probe:live` で明示的に行います
（[実行方法](docs/probe-results.md)）。

## サーバーの起動

サーバーは 1 つの data directory を専有します。現段階ではネットワークの listener を開きません。

1. data directory をコード checkout の外に作ります。checkout の中を指定すると起動を拒否します。
2. [config.example.json](config.example.json) を `config.local.json` などにコピーし、Pi 状態領域のパスを実環境に合わせます。
   Pi 状態領域は data directory ともホームの `.pi` / `.codex` とも別の場所にします。
3. ビルドして起動します。

```sh
npm run build
node dist/src/server/main.js serve --config config.local.json --data-dir <data directory>
```

`--data-dir` を省略すると起動 cwd を data directory とします。初回起動で `memory/`、`personality.md`、
`.natsumi/`（状態 DB・ロック・状態ファイル）を作ります。既存のファイルは上書きしません。
同じ data directory で 2 つ目のサーバーを起動すると拒否します。異常終了後のロックは OS が解放するため、そのまま再起動できます。
SIGTERM / SIGINT で停止します。

稼働状態は `node dist/src/server/main.js health --data-dir <data directory>` で確認できます（稼働中なら終了コード 0）。

設定の不備（未知の項目、相対パス、秘密の直書きなど）は、該当する設定名を示して起動を止めます。
秘密は設定ファイルに書かず、`...Env`（環境変数名）や `...File`（secret mount のパス）で参照します。

## コンテナ

```sh
docker compose config --quiet
docker compose build
docker compose up -d
```

data directory は named volume `natsumi-data`（`/data`）、Pi 状態領域は `natsumi-pi`（`/var/lib/natsumi-pi`）に永続化され、
コンテナを作り直しても残ります。コンテナは非 root ユーザーと読み取り専用のルートファイルシステムで動き、ポートを公開しません。
設定は既定で `config.example.json` を読み取り専用でマウントします。実環境の設定は `NATSUMI_CONFIG=./config.local.json` で指定します。
volume の代わりに既存のディレクトリを bind mount する場合は、所有者をコンテナの `node` ユーザー（UID 1000）に合わせてください。

## 文書

- [設計 ADR](docs/adr/0001-server-and-data-ownership.md): データ所有権、[通信・承認](docs/adr/0002-client-events-and-approvals.md)、[外部連携](docs/adr/0003-assistance-and-integrations.md)、[Pi のツール・認証・音声](docs/adr/0004-pi-tool-and-voice-boundaries.md)、[サーバー基盤](docs/adr/0005-server-foundation.md)
- [サーバーと Mac の契約・実装順](docs/client-contract.md)
- [実接続の実行方法と結果](docs/probe-results.md)
- [設定例](config.example.json): 現在サーバーが受け付ける設定だけを載せています。後続の実装で項目を追加します。検証ハーネスはこのファイルを読みません。

個人 Markdown、SQLite、Pi の session・認証、ログ、private Wiki はコード checkout の外に置きます。
ignore は事故防止の補助です。設定例を実環境に合わせたファイルは `config.local.json` として管理し、
秘密は環境変数や secret mount で渡します。個人データを公開 Git に保存しません。
