# natsumi

Pi Coding Agent を使う個人アシスタント。現在はサーバー基盤（設定の検証、data directory の初期化、
二重起動の拒否、状態 DB の migration、専用の Pi 状態領域、コンテナ）、GitHub ログインと短期セッション、
HTTPS/WSS の待ち受けと v1 envelope の入口、Let's Encrypt（ACME HTTP-01）による証明書の自動取得、
固定 IPv6 で公開するコンテナ構成、Pi SDK の隔離検証ハーネスを提供しています。
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
     `tls` には証明書と鍵のファイル、または Let's Encrypt から自動取得する `acme` を指定します。
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
- ファイルで渡した証明書を更新したら、サーバーを再起動します。
- 同じホストのリバースプロキシで TLS を終端する場合に限り、`"host": "127.0.0.1"`（または `"::1"`）と `"tls": false` を指定できます。
  loopback 以外のアドレスで `tls: false` を指定すると起動を拒否します。

### Let's Encrypt で証明書を自動取得する

`listen.tls` に証明書ファイルの代わりに `acme` を指定すると、サーバーが `publicOrigin` のホスト名の証明書を
ACME の HTTP-01 で取得し、更新します（[ADR 0007](docs/adr/0007-acme-and-fixed-ipv6.md)）。
設定例は [config.acme.example.json](config.acme.example.json) です。証明書ファイルの指定と `acme` は同時に指定できません。

- `acme.directoryUrl`: 省略すると Let's Encrypt の本番（`https://acme-v02.api.letsencrypt.org/directory`）を使います。
  試験には staging（`https://acme-staging-v02.api.letsencrypt.org/directory`）を指定します。staging の証明書は Mac に信頼されません。
- `acme.contactEmail`: 任意です。CA からの連絡先になります。
- `acme.httpPort`: challenge に答える平文のポートで、既定は 80 です。CA は 80 番に接続するので、変える場合は外側で 80 番をこのポートへ転送します。
- `acme` を指定すると、CA の利用規約（Let's Encrypt の Subscriber Agreement）に同意したものとしてアカウントを登録します。
- `publicOrigin` は DNS のホスト名にします（IP アドレスは不可）。DNS のレコードがこのサーバーを指し、
  ファイアウォールで tcp 80 と `listen.port`（通常は 443）が外から届く必要があります。
- 80 番では、発行中の challenge への応答と、`publicOrigin` の https への redirect だけを返します。ログイン・API・WebSocket にはつながりません。
- 起動時に使える証明書がなければ、取得できるまで HTTPS の待ち受けを開きません。その間、`health` は `waiting-for-certificate` で異常を返します。
  取得に失敗すると、15 分後から間隔を倍にしながら、最大 12 時間の間隔で再試行します。
- 残りが 30 日（寿命の短い証明書では寿命の 3 分の 1）を切ると更新し、再起動なしで新しい接続に使います。
  更新に失敗しても、古い証明書のまま動き続けます。
- アカウント鍵と証明書は data directory の `.natsumi/acme/` に保存され（ディレクトリは 0700、ファイルは 0600）、再起動しても再発行しません。
  バックアップの対象に含めてください。失うと新しいアカウントで再発行することになり、CA のレート制限に当たることがあります。

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

### 固定 IPv6 で公開する

ルーターの RA で IPv6 のプレフィックスが配られる external network に、固定の IPv6 アドレスで直接つなぐ構成を、
override の [compose.ipv6.example.yaml](compose.ipv6.example.yaml) として用意しています。証明書は Let's Encrypt から取得します
（[ADR 0007](docs/adr/0007-acme-and-fixed-ipv6.md)）。このファイルの値はすべて架空のものです。

```sh
docker compose -f compose.yaml -f compose.ipv6.example.yaml up -d
```

- network の前提: Docker から見て IPv4 だけの external network で、同じリンクのルーターが /64 のプレフィックスを RA で配っていること。
  Docker はプレフィックスを知らないので、Docker にアドレスを割り当てさせることはできません。
- 仕組み: `natsumi-net` コンテナがネットワークの名前空間を持ち、そのインターフェースだけ IPv6 を有効にして、
  `ip token` でインターフェース ID（トークン）を設定します。アドレスは RA のプレフィックスとトークンで決まります。
  natsumi はその名前空間を共有し、非 root・全 capability なしのまま 80 / 443 で待ち受けます。
  `NET_ADMIN` を持つのは `natsumi-net` だけです。natsumi だけを再起動しても、アドレスは変わりません。
- トークンを設定できない、トークンのアドレスが 60 秒以内に使えるようにならない、アドレスが重複している、のいずれかの場合、
  `natsumi-net` はエラーを出して終了し、natsumi は起動しません。
- 実際の値: Git の追跡対象外の `.env` に、network 名を `NATSUMI_IPV6_NETWORK`、トークン（例: `::10`）を `NATSUMI_IPV6_TOKEN` として書きます。
  どちらかが未設定だと compose が止まります。設定ファイルは `NATSUMI_CONFIG` で指定し（既定は `config.acme.example.json`）、
  `publicOrigin` に実際のホスト名を、`listen` に 443 番と `acme` を書きます。この構成では GitHub の client secret だけをマウントします。
- DNS: `publicOrigin` のホスト名に、プレフィックスとトークンからなるアドレスの AAAA レコードを作ります
  （例: プレフィックスが `2001:db8:0:1::/64`、トークンが `::10` なら `2001:db8:0:1::10`）。IPv4 のアドレスは外から届かないので、A レコードは作りません。
- ファイアウォール: そのアドレスへの tcp 443（HTTPS）と tcp 80（ACME の challenge）を外から通します。
- 証明書とアカウント鍵は `natsumi-data` volume の `.natsumi/acme/` に入ります。volume ごとバックアップしてください。
- `natsumi-net` を再作成すると、natsumi も再起動します。
- 名前空間にはトークンのアドレスのほかに自動設定のアドレスが残ることがあり、外向きの通信の送信元はそちらになり得ます。

## 文書

- [設計 ADR](docs/adr/0001-server-and-data-ownership.md): データ所有権、[通信・承認](docs/adr/0002-client-events-and-approvals.md)、[外部連携](docs/adr/0003-assistance-and-integrations.md)、[Pi のツール・認証・音声](docs/adr/0004-pi-tool-and-voice-boundaries.md)、[サーバー基盤](docs/adr/0005-server-foundation.md)、[GitHub ログインと HTTPS/WSS](docs/adr/0006-github-login-and-transport.md)、[Let's Encrypt と固定 IPv6](docs/adr/0007-acme-and-fixed-ipv6.md)
- [サーバーと Mac の契約・実装順](docs/client-contract.md)
- [実接続の実行方法と結果](docs/probe-results.md)
- [設定例](config.example.json)（証明書ファイル）と [ACME の設定例](config.acme.example.json): 現在サーバーが受け付ける設定だけを載せています。後続の実装で項目を追加します。検証ハーネスはこのファイルを読みません。

個人 Markdown、SQLite、Pi の session・認証、ログ、private Wiki、証明書や secret はコード checkout の外に置きます。
ignore は事故防止の補助です。設定例を実環境に合わせたファイルは `config.local.json` として管理し、
秘密は環境変数や secret mount で渡します。個人データを公開 Git に保存しません。
