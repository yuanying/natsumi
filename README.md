# natsumi

Codex App Server を使う個人アシスタント。現在は初期設計と隔離検証ハーネスを提供しています。
アプリ本体、コンテナ、Mac UI、Google/Wiki 連携は後続実装です。

Node.js 24.12.0 以降を使用します。通常の検証は外部認証・Codex CLI・ネットワーク接続を必要としません
（初回の npm 依存取得を除く）。ランタイムの npm 依存はありません。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` は Node 標準 test runner で架空の stdio fixture を実行します。
build 結果は `dist/` に生成されます。

- [設計 ADR](docs/adr/0001-server-and-data-ownership.md): データ所有権、[通信・承認](docs/adr/0002-client-events-and-approvals.md)、[外部連携](docs/adr/0003-assistance-and-integrations.md)、[音声](docs/adr/0004-realtime-validation-gate.md)
- [サーバーと Mac の契約・実装順](docs/client-contract.md)
- [実接続の実行方法と結果](docs/probe-results.md)
- [架空の設定例](config.example.json): 後続の本体用設計例です。ハーネスはこのファイルを読みません。

個人 Markdown、SQLite、Codex home、認証、ログ、private Wiki はコード checkout の外に置きます。
ignore は事故防止の補助です。設定例を実環境に合わせたファイルは `config.local.json` として管理し、
秘密は環境変数や secret mount で渡します。個人データを公開 Git に保存しません。
