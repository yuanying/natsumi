# natsumi

Pi Coding Agent を使う個人アシスタント。現在はサーバー基盤（設定の検証、data directory の初期化、
二重起動の拒否、状態 DB の migration、専用の Pi 状態領域、コンテナ）、GitHub ログインと短期セッション、
HTTPS/WSS の待ち受けと v1 envelope の入口、Pi SDK の隔離検証ハーネスを提供しています。
会話、Mac UI、Google/Wiki 連携は後続の実装です。

Node.js 24.12.0 以降を使用します。通常の検証は外部認証・ネットワーク接続を必要としません
（初回の npm 依存取得を除く）。Pi は `@earendil-works/pi-coding-agent` の SDK を npm 依存として固定しています。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` は Node 標準 test runner で、サーバー基盤の試験、GitHub を模したローカルサーバーを使うログインと WSS の試験、
モデル応答を合成 stream に差し替えた Pi SDK の fixture を実行します。TLS の試験は `openssl` で一時的な証明書を作ります
（`openssl` がなければその試験だけ skip します）。
build 結果は `dist/` に生成されます。実際のモデルへ接続する検証は `npm run probe:live` で明示的に行います
（[実行方法](docs/probe-results.md)）。

## サーバーの起動

サーバーは 1 つの data directory を専有し、HTTPS/WSS で待ち受けます。以下のホスト名・ID は架空の例です。

1. data directory をコード checkout の外に作ります。checkout の中を指定すると起動を拒否します。
2. 下記の手順で GitHub OAuth App と TLS 証明書を用意します。
3. [config.example.json](config.example.json) を `config.local.json` などにコピーし、実環境に合わせます。
   - `pi`: Pi 状態領域のパス。data directory ともホームの `.pi` / `.codex` とも別の場所にします。
   - `publicOrigin`: クライアントが使う origin（例: `https://natsumi.example.net:8443`）。https に限ります。
   - `listen`: 待ち受けアドレス・ポート・TLS。`"host": "::"` で IPv4 と IPv6 の両方で待ち受けます。
     `tls` には証明書と鍵のファイルを指定します。
   - `github`: OAuth App の client ID、client secret の参照（`clientSecretEnv` か `clientSecretFile`）、callback URL、
     許可するアカウントの数値 ID（`allowedUserId`）。
4. ビルドして起動します。

```sh
npm run build
node dist/src/server/main.js serve --config config.local.json --data-dir <data directory>
```

`--data-dir` を省略すると起動 cwd を data directory とします。初回起動で `memory/`、`personality.md`、
`.natsumi/`（状態 DB・ロック・状態ファイル）を作ります。既存のファイルは上書きしません。
同じ data directory で 2 つ目のサーバーを起動すると拒否します。異常終了後のロックは OS が解放するため、そのまま再起動できます。
SIGTERM / SIGINT で停止します。

稼働状態は `node dist/src/server/main.js health --data-dir <data directory>` で確認できます（稼働中なら終了コード 0）。

設定の不備（未知の項目、相対パス、秘密の直書き、外部アドレスでの平文の待ち受けなど）は、該当する設定名を示して起動を止めます。
秘密は設定ファイルに書かず、`...Env`（環境変数名）や `...File`（secret mount のパス）で参照します。

### GitHub OAuth App を作る

1. GitHub の Settings → Developer settings → OAuth Apps → New OAuth App を開きます。
2. Homepage URL に `publicOrigin`（例: `https://natsumi.example.net:8443`）を、
   Authorization callback URL に `publicOrigin` + `/auth/github/callback`
   （例: `https://natsumi.example.net:8443/auth/github/callback`）を入力して登録します。
   この callback URL を設定の `github.callbackUrl` にも書きます。
3. 表示された Client ID を `github.clientId` に書きます。
4. Generate a new client secret で secret を作り、ファイル（例: `secrets/github-client-secret`）か環境変数に保存します。
   設定には `clientSecretFile` でファイルのパスを、または `clientSecretEnv` で環境変数名を書きます。secret 自体は書きません。
5. 許可する自分のアカウントの数値 ID を調べ、`github.allowedUserId` に数値で書きます。
   `https://api.github.com/users/<ログイン名>` の `id`、または `gh api user --jq .id` で確認できます。
   ログイン名は判定に使いません。ログイン名を変えても ID は変わりません。

サーバーは scope を要求せず、GitHub のアクセストークンは数値 ID の確認にだけ使って保存しません。
ログインの流れと Mac アプリ側の契約は [client-contract.md](docs/client-contract.md) の「ログインとセッション」にあります。

### TLS を設定する

TLS はサーバー自身で終端します（[ADR 0006](docs/adr/0006-github-login-and-transport.md)）。

- `publicOrigin` のホスト名に対する証明書と秘密鍵を PEM で用意し、`listen.tls.certFile` / `keyFile` に指定します。
  中間証明書がある場合は `certFile` にサーバー証明書に続けて連結します。
- Mac からの接続では、Mac が信頼する証明書（公的な CA が発行したもの、または Mac に登録した私的な CA のもの）を使います。
- 証明書を更新したら、サーバーを再起動します。
- 同じホストのリバースプロキシで TLS を終端する場合に限り、`"host": "127.0.0.1"`（または `"::1"`）と `"tls": false` を指定できます。
  loopback 以外のアドレスで `tls: false` を指定すると起動を拒否します。

## コンテナ

```sh
docker compose config --quiet
docker compose build
docker compose up -d
```

data directory は named volume `natsumi-data`（`/data`）、Pi 状態領域は `natsumi-pi`（`/var/lib/natsumi-pi`）に永続化され、
コンテナを作り直しても残ります。コンテナは非 root ユーザーと読み取り専用のルートファイルシステムで動きます。
設定は既定で `config.example.json` を読み取り専用でマウントします。実環境の設定は `NATSUMI_CONFIG=./config.local.json` で指定します。
volume の代わりに既存のディレクトリを bind mount する場合は、所有者をコンテナの `node` ユーザー（UID 1000）に合わせてください。

- ポート: コンテナの 8443 番をホストの `${NATSUMI_PORT:-8443}` 番に公開します。IPv6 での公開には Docker daemon の IPv6 設定が必要です。
- 秘密: 証明書・鍵・GitHub client secret は Compose の secrets として `/run/secrets/natsumi_tls_cert`、`natsumi_tls_key`、
  `natsumi_github_client_secret` にマウントされます。設定例はこのパスを参照しています。
  既定ではホストの `secrets/tls-cert.pem`、`secrets/tls-key.pem`、`secrets/github-client-secret` を読みます
  （`NATSUMI_TLS_CERT`、`NATSUMI_TLS_KEY`、`NATSUMI_GITHUB_CLIENT_SECRET_FILE` で変更できます）。
  `secrets/` は Git の追跡対象外です。ファイルはホストの権限のままマウントされるため、UID 1000 だけが読めるようにしてください。

## 文書

- [設計 ADR](docs/adr/0001-server-and-data-ownership.md): データ所有権、[通信・承認](docs/adr/0002-client-events-and-approvals.md)、[外部連携](docs/adr/0003-assistance-and-integrations.md)、[Pi のツール・認証・音声](docs/adr/0004-pi-tool-and-voice-boundaries.md)、[サーバー基盤](docs/adr/0005-server-foundation.md)、[GitHub ログインと HTTPS/WSS](docs/adr/0006-github-login-and-transport.md)
- [サーバーと Mac の契約・実装順](docs/client-contract.md)
- [実接続の実行方法と結果](docs/probe-results.md)
- [設定例](config.example.json): 現在サーバーが受け付ける設定だけを載せています。後続の実装で項目を追加します。検証ハーネスはこのファイルを読みません。

個人 Markdown、SQLite、Pi の session・認証、ログ、private Wiki、証明書や secret はコード checkout の外に置きます。
ignore は事故防止の補助です。設定例を実環境に合わせたファイルは `config.local.json` として管理し、
秘密は環境変数や secret mount で渡します。個人データを公開 Git に保存しません。
