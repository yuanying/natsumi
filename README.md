# natsumi

Pi Coding Agent を使う個人アシスタント。現在はサーバー基盤（設定の検証、data directory の初期化、
二重起動の拒否、状態 DB の migration、専用の Pi 状態領域、コンテナ）、GitHub ログインと短期セッション、
HTTPS/WSS の待ち受けと v1 envelope の入口、Let's Encrypt（ACME HTTP-01）による証明書の自動取得、
固定 IPv6 で公開するコンテナ構成、Pi SDK の隔離検証ハーネス、単一の思考ループによる Mac との会話
（端末の登録と同期、表情、表示用の会話の記録）、git で持つ Markdown の長期記憶、閉じ込めたコンテナの中の作業環境と、
夜の思考の記録の切り替えを提供しています。
Mac アプリは土台（ログイン、会話の同期、デスクトップに常駐するキャラクター、その上の吹き出しと下の入力欄、履歴）ができています。
Slack、通知・スケジューラー、承認の表示、Google/Wiki 連携は後続の実装です。

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
     `model` でモデルを選びます。専用領域で login した Pi のサブスクリプション（例: `openai-codex`）か、
     `"provider": "natsumi-compatible"` と `compatible`（自分で動かす OpenAI 互換エンドポイントの `baseUrl` と、
     API key の参照 `apiKeyEnv` か `apiKeyFile`）の組です。両者の間で自動の切り替えはしません。
     `thinking` は既定で `"on"`（思考あり）で、`"off"` にもできます。
   - `publicOrigin`: クライアントが使う origin（例: `https://natsumi.example.net:8443`）。https に限ります。
   - `listen`: 待ち受けアドレス・ポート・TLS。`"host": "::"` で IPv4 と IPv6 の両方で待ち受けます。
     `tls` には証明書と鍵のファイル、または Let's Encrypt から自動取得する `acme` を指定します。
   - `github`: OAuth App の client ID、client secret の参照（`clientSecretEnv` か `clientSecretFile`）、callback URL、
     許可するアカウントの数値 ID（`allowedUserId`）。
   - `loop`（省略可）: 本人のタイムゾーン `timeZone`（例: `Asia/Tokyo`、既定 `UTC`）、夜の切り替えの時刻 `nightlyRotationAt`
     （既定 `"04:00"`、`false` で自動では切り替えない）、compaction の上限 `compactionThreshold`（既定 60000 tokens）と、
     要約せずに残す直近の量 `compactionKeepRecent`（既定 20000 tokens）。
     起きている時間帯 `awakeHours`（既定 `{ "start": "08:00", "end": "23:00" }`）、合図までの静かな時間 `pingIntervalMinutes`
     （既定 30 分、`false` で合図を出さない）、自分で予約する確認の上限 `selfCheck`（最短の先 `minDelayMinutes` 既定 5 分、
     最も遠い先 `maxDelayDays` 既定 7 日、同時に待たせる件数 `maxPending` 既定 5 件、1 日の件数 `maxPerDay` 既定 20 件）、
     表情が neutral に戻るまでの時間 `expressionResetMinutes`（既定 3 分）。
     記憶のリポジトリの場所 `memoryRepository`（絶対パス。既定は data directory の `memory/`）と、
     記憶 1 ファイルの上限 `memoryFileMaxChars`（既定 32000 文字）。
     作業環境の runner のソケット `workspaceSocket`（絶対パス。これがあるときだけ `run_shell` が使えます）、
     runner の応答を待つ秒数 `shellWaitSeconds`（既定 75 秒。runner 側の応答の上限 60 秒より長くします）、
     永続する書き場所の合計の目安 `workspaceSizeWarnBytes`（既定 1 GiB。超えると次のターンで natsumi に知らせます）。
4. ビルドして起動します。

```sh
npm run build
node dist/src/server/main.js serve --config config.local.json --data-dir <data directory>
```

`--data-dir` を省略すると起動 cwd を data directory とします。初回起動で `memory/`（記憶のリポジトリ）、
`work/` と `home/`（作業環境の `/work` と `/home/natsumi`）、`.natsumi/`（状態 DB・ロック・状態ファイル）を
作ります。既存のファイルは上書きしません。
同じ data directory で 2 つ目のサーバーを起動すると拒否します。異常終了後のロックは OS が解放するため、そのまま再起動できます。
SIGTERM / SIGINT で停止します。

会話は、一本の Pi session が思考ループとして本人のメッセージを 1 件ずつ処理し、ツールで返事や表情を出す形です
（[ADR 0008](docs/adr/0008-single-thinking-loop-and-mac-conversation.md)）。本人のメッセージと natsumi の返事・知らせは
`.natsumi/state.sqlite` に、思考の記録は Pi の session に保存されます。どちらも個人データとして一緒にバックアップしてください。
Pi の session ファイルが消えた・壊れた場合は新しい session を作らず、会話を使えない状態で起動します。

長期記憶は 1 つの git リポジトリです（[ADR 0018](docs/adr/0018-memory-in-git-and-the-nightly-rebuild.md)）。
場所は `loop.memoryRepository`、既定は data directory の `memory/` で、初回起動でそこが git のリポジトリになります
（ブランチは `main`）。すでにあった Markdown は、名前も中身も変えずに最初のコミットに入ります。
記憶そのものは、これまでどおりトピックごとの Markdown ファイルで、見出しと日付付きの箇条書きの行でできています
（[ADR 0009](docs/adr/0009-long-term-memory-and-nightly-session-switch.md)）。natsumi はこのファイルを `run_shell` で
読み書きします（[ADR 0019](docs/adr/0019-a-workspace-not-a-memory-tool.md)。専用の記憶のツールはもうありません）。
手で読んで直すこともできますし、直下に手で置いた `.md` ファイルも natsumi が探す対象になります。

サーバーが名前と置き場所を決めるのは、リポジトリ直下の 3 つだけです。

| ファイル | 中身 |
| --- | --- |
| `always.md` | 常時記憶。夜のターンでだけ書き換えられます（毎回のプロンプトに入れるのは後続の実装） |
| `personality.md` | 性格・話し方。session を作るときにプロンプトに入ります。夜のターンでだけ書き換えられます |
| `handoff.md` | 夜の引き継ぎ。初回起動で、そのときの最新の引き継ぎを写します（引き継ぎ自体を SQLite からこのファイルへ移すのは後続の実装） |

記憶に変更があったターンの終わりごとに、サーバーが 1 回コミットします。順序は、ターンが終わる → 変わったファイルを
検査 → 当たったものを直前のコミットの状態に戻す（新しいファイルは消す）→ 残りをコミット、です。ターンがモデル呼び出しの
上限や時間切れで終わったときも同じように検査してコミットします。検査は `.md` 以外・symlink・空・
`loop.memoryFileMaxChars`（既定 32000 文字）超過・テンプレートの制御文字列・制御文字・日本語以外の文字と、
日中のターンでの `always.md`・`personality.md` の変更です。戻した理由は次のターンで natsumi に伝わります。

natsumi が作ったファイルは、削除も改名も検査しません。全部消しても履歴から戻せます。上の 3 つだけは別で、
消すことも改名することもできません（戻したうえで理由を伝えます）。サーバーはこの 3 つが直下にある前提で動くので、
黙って消えるとその前提が崩れます。

**サーバーは commit だけを行い、push も pull もしません。** リモートを設定するか、外へ出すかはオーナーが決めます。
リポジトリには本人の私的なことがそのまま残るので、リモートを作るなら private にしてください。
author と committer はサーバーが固定し、リポジトリに置かれた git の hook は実行しません。

毎晩 `loop.nightlyRotationAt` に、natsumi はその日を振り返って記憶を整理し、引き継ぎのメモを持って新しい Pi session に切り替えます。
古い session ファイルは消さずに残るので、Pi の session 領域は日ごとに増えます。日中に context が `loop.compactionThreshold` を超えると、
イベントの合間に古い部分を要約します。記憶のリポジトリ、`.natsumi/state.sqlite`、Pi の session 領域は一組でバックアップしてください。

natsumi は自分から動くこともあります（[ADR 0014](docs/adr/0014-self-checks-and-pings.md)）。
`loop.awakeHours` の間、会話や処理のない時間が `loop.pingIntervalMinutes` 続くと、サーバーが「何かしたいことは？」の合図を送ります。
また natsumi は「30 分後」「15:00」のように、後で自分から確かめる予約を入れられます。予約は `.natsumi/state.sqlite` に残り、
サーバーの停止や夜で時刻を過ぎたものは、起動後（夜なら朝）にまとめて 1 回で届きます。予約の件数と間隔は `loop.selfCheck` でサーバーが制限します。
どちらもモデルを使うので、静かな時間にもモデルの利用が発生します。

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

### natsumi の作業環境（natsumi-workspace）

natsumi は `run_shell` でコマンドを動かします。コマンドは natsumi の中ではなく、閉じ込めたコンテナ
`natsumi-workspace` の中で動きます（[ADR 0011](docs/adr/0011-memory-shell-in-a-confined-container.md)、
[ADR 0019](docs/adr/0019-a-workspace-not-a-memory-tool.md)）。記憶を探す道具ではなく、記憶の整理も調べものも
下書きも集計もそこで行う作業机です。

- 構成
  - natsumi は、共有する小さな tmpfs の volume（`natsumi-workspace-socket`）にある Unix ソケットで、
    `natsumi-workspace` の実行役（runner）にコマンドを送ります。
  - natsumi に Docker のソケットは渡しません。
  - ツールは、設定の `loop.workspaceSocket`（設定例では `/run/natsumi-workspace/runner.sock`）があるときだけ使えます。
- 入っているもの: debian-slim に標準の道具（`coreutils`・`findutils`・`diffutils`・`grep`・`sed`・`gawk`・`tar`・`gzip`・`bash`）と、
  `ripgrep`・`python3`（標準ライブラリのみ）・`git`・`procps`・`tzdata`、それに runner です。
  **使えるコマンドの一覧はもうありません。** 閉じ込めはコンテナの形だけで掛けます。
- 書ける場所は 4 つです。ルートは読み取り専用のままです。

  | 場所 | 永続 | 検査・コミット | 中身 |
  | --- | --- | --- | --- |
  | `/memory` | する | する | 記憶。`natsumi-data` の `memory/` |
  | `/memory/.git` | する | — | 読み取り専用で重ねます。履歴は natsumi の手の届かないところに置きます |
  | `/work` | する | しない | 手を動かす場所。`natsumi-data` の `work/` |
  | `/home/natsumi` | する | しない | natsumi のホーム。`natsumi-data` の `home/` |
  | `/tmp` | しない | — | 128 MB の tmpfs。コンテナの再起動で消えます |

  `/work` と `/home/natsumi` はサーバーが見ません。ターンの終わりの検査もコミットも掛からず、
  git の差分でも見られません。中を見るときはオーナーが自分でコンテナに入ります。
- 閉じ込め
  - ネットワークはありません（`network_mode: none`）。
  - `natsumi-data` の上の 3 つだけをマウントします。SQLite、Pi の状態領域、secrets、設定は見えません。
  - 非 root で動き、全 capability を外し、`no-new-privileges` を付けます。
  - `/tmp` には `noexec` を付けますが、**境界としては数えません。** インタプリタがある以上、
    `python3 /tmp/x.py` は止まりません。
- 上限
  - CPU 2、メモリ 1 GB（swap なし）、プロセス数 256
  - **1 つのコマンドに時間の上限はありません。** 応答の上限（60 秒）までに終わらなければ、
    そこまでの出力と「まだ動いている」印が返り、プロセスはそのまま動き続けます。
    返した後も runner が出力を読み捨て続けるので、コマンドが詰まることはありません。
    残ったプロセスを止めるのは natsumi です（`ps` と `kill`）。サーバーは止めません。
  - 出力は標準出力・標準エラー出力それぞれ 64 KiB まで（モデルに返すのは標準出力 8000 文字・標準エラー出力 2000 文字まで）
  - 1 つのコマンドの長さは 8000 文字まで。超えるとサーバーが送る前に拒否します。
  - 応答の上限と出力の上限は `compose.yaml` の `command` で、サーバー側の待ち時間は `loop.shellWaitSeconds` で変えられます。
- 環境変数: コマンドには `PATH`・`PWD`・`HOME`・`LANG`・`TZ` の 5 つだけを渡します。コンテナ自体の環境変数は空のままです。
  `TZ` はサーバーがコマンドごとに `loop.timeZone` を送ります（`NATSUMI_TIME_ZONE` は runner 側の既定値です）。
- 大きさ: `/memory`・`/work`・`/home/natsumi` の合計が `loop.workspaceSizeWarnBytes`（既定 1 GiB）を超えると、
  次のターンで natsumi に内訳つきで知らせます。強制はしないので、片づけないままだといつかはディスクが埋まります。
- UID: これらのファイルは所有者だけが読めるので、`natsumi-workspace` は natsumi と同じ UID で動かします（既定は 1000）。
  natsumi を別の UID で動かすときは、`NATSUMI_WORKSPACE_UID` に同じ値を入れます。
- 起動の順番: natsumi が初回の起動で `memory/`・`work/`・`home/` を作るので、`natsumi-workspace` は
  natsumi が healthy になってから起動します。
- 閉じ込めの確認: [scripts/check-workspace-sandbox.sh](scripts/check-workspace-sandbox.sh) が、使い捨ての project で
  2 つのコンテナを起動し、コンテナの形（ネットワーク、マウント、権限、資源の上限、見えない秘密、環境変数）と、
  終わらないコマンドが応答の上限で返りそのプロセスが生き残ることを、runner 経由で確かめます。
  image 名を変える override を用意して、先に build してから実行します。
  **運用中の環境と同じ image 名で build すると、そのタグを上書きします。** build する前に
  `docker compose ... config --images` に `:local` が出ないことを確かめてください。

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

## Mac アプリ

`mac/` に Xcode プロジェクトがあります（[ADR 0010](docs/adr/0010-mac-app-structure.md)）。macOS 15 以降と Xcode 27 を使います。
署名は ad-hoc で、Apple Developer のチームや証明書は要りません。配布（公証・自動更新）はまだ扱っていません。

```sh
xcodebuild build -project mac/Natsumi.xcodeproj -scheme Natsumi -destination 'platform=macOS' -derivedDataPath mac/build
xcodebuild test -project mac/Natsumi.xcodeproj -scheme Natsumi -destination 'platform=macOS' -derivedDataPath mac/build
```

- scheme `Natsumi` は、アプリ `Natsumi`、ロジックの framework `NatsumiCore`、そのテスト `NatsumiCoreTests` を含みます。
  テストは外部ネットワークにもサーバーにも接続しません。Keychain を使うテストがあるため、ログイン中のユーザーの GUI のセッション
  （ターミナル.app など）で実行してください。SSH のセッションからはキーチェーンを開けません。
- build 結果は `mac/build/`（Git の追跡対象外）にでき、アプリは `mac/build/Build/Products/Debug/Natsumi.app` です。

### 使い方

1. アプリを起動すると、メニューバーにアイコンが、デスクトップにキャラクターが出ます。キャラクターはドラッグで動かせます。
2. キャラクターを右クリック（または control キーを押しながらクリック）して出るメニューの「設定…」で、サーバーの URL（例: `https://natsumi.example.net`）を入れて保存します。
3. 「GitHub でログイン」で、ブラウザのシートからログインします。セッションのトークンは Keychain にだけ保存されます。
   期限（12 時間）が切れたり失効したりすると、ログインを求められます。
4. キャラクターをクリックすると、キャラクターの下（画面の上の端では上）に入力欄が出ます。Enter で送り、Shift+Enter で改行します（日本語の変換を確定する Enter では送りません）。
   入力欄は、Esc、もう一度キャラクターをクリック、ほかのアプリをクリックのどれかで閉じます。
   - 行が増えると入力欄が伸び、160 ポイント（または自分で決めた高さ）を超えると中でスクロールします。
   - 入力欄の右下のつまみをドラッグすると、幅（200〜640 ポイント）と文字の欄の高さ（40〜400 ポイント）を変えられます。大きさは次の起動でも残り、キャラクターの大きさとは別に保存されます。
   接続していないときやログインが必要なときは、入力欄の上に状態と「GitHub でログイン」などのボタンが出ます。
5. natsumi の返事のうち、まだ確かめていないものが、キャラクターの上の白い吹き出しに古い順に重なって出ます。
   - 前に出ている返事の本文をクリックすると、確かめたことになり、次の返事が前に出ます。後ろの返事は縁と「あと N 件」で分かります。
   - 右上の × は、残りの返事をすべて既読にして閉じます。最後の 1 件を確かめたときも吹き出しは閉じます。内容は履歴で見られます。
   - キャラクターの右クリックのメニューの「返事をすべて既読にする」も、× と同じです。
   - 長い発言は 120 文字・5 行までを出し、「続きは履歴で」から全文を見られます。履歴を開いただけでは、確かめたことになりません。
   - 確かめていない返事が無いとき、送った直後は「受付中」、返事を考えている間は「考え中」の点が出ます。返事が残っている間は、吹き出しの小さな回る印で考え中を示します。
   - 確かめたかどうかはサーバーに記録され、ほかの Mac とも共通です。アプリを起動し直しても戻りません。
6. natsumi からの知らせは、返事とは別に、吹き出しのさらに上（返事が無ければキャラクターのすぐ上）の黄色い束に出ます。キャラクターの右上には、確かめていない知らせの件数の黄色い印が付きます。
   - 前に出ている知らせの本文をクリックすると確かめたことになり、次の知らせが前に出て、印の件数が減ります。右上の × と、右クリックのメニューの「知らせをすべて確認する」は、すべての知らせを確かめて閉じます。
   - 返事も知らせも、後ろに重なっている件数は本文の下に「あと N 件」と出ます。
   - 印をクリックすると、知らせの束を隠したり出したりできます。隠しても確かめたことにはならず、新しい知らせが届くとまた出ます。
   - 履歴に残っていない古い知らせは、「前の知らせが N 件」の 1 枚にまとめて出し、クリックでまとめて確かめます。
7. 過去の会話は、入力欄の時計のボタン、キャラクターの右クリックのメニュー、メニューバーの「履歴を開く」のどれかで、キャラクターの横に開きます。
   知らせは黄色で「お知らせ」が付き、確かめていない返事と知らせには「未読」「未確認」の印が付きます。閉じるボタンか、履歴を選んだ状態の Esc で閉じます。
8. キャラクターの右クリックのメニューには、話しかける・履歴を開く・返事をすべて既読にする・知らせをすべて確認する・設定…・ログアウト・終了があります。メニューバーのアイコンには、既読と確認の 2 つを除く同じ項目があります。
9. キャラクターの大きさは、設定の「キャラクター」で 50% から 200% まで 25% 刻みで変えられます。すぐに反映され、次の起動でも残ります。

キャラクター・吹き出し・知らせの束・入力欄・履歴は、どれもほかのウインドウの上に浮かび、すべての Space と全画面表示のアプリの上にも出ます。

- 知らせの束・吹き出し・キャラクター・入力欄は、上からこの順に、キャラクターの中心の縦の線にそろって一列に並び、キャラクターと一緒に動きます。
- 画面の上の端では、一列が上下に反転します（キャラクターの下に吹き出しと知らせ、上に入力欄）。
- 横の端では、パネルだけが内側にずれます。
- 高さが足りないときは、重なりを減らし、本文の行数を減らします。
- パネルを出したり隠したりしても、キャラクターの位置は変わりません。キャラクターが動くのは、ドラッグしたときと大きさを変えたときだけです。
- 履歴は、一列の横の空いている側に開きます。
- 吹き出し・知らせ・入力欄は、黒い輪郭の漫画の吹き出し風で、ダークの外観でも白地（知らせは黄色地）に黒い文字です。
入力欄と履歴はキーボードの入力を受け取りますが、アプリを前面にしないので、それまで使っていたアプリは前面のままです。

ad-hoc 署名はビルドのたびに変わるため、ビルドし直したアプリが Keychain のトークンを読むときに、確認のダイアログが出ることがあります。

### アバターを差し替える

キャラクターの絵は、既定では同梱の `mac/Avatars/natsumi/` を使います。自分のアセットを試すときは、次の場所に置きます
（設定の「アバター」で場所を変えられます）。ここに読めるアセットがあれば、同梱のものより優先します。どちらも読めなければ、仮の絵（絵文字）になります。

```sh
mkdir -p ~/Library/Application\ Support/natsumi/avatar
cp <アセットのディレクトリ>/pet.json <アセットのディレクトリ>/spritesheet.webp ~/Library/Application\ Support/natsumi/avatar/
```

- 形式は Codex のペット（`pet.json` と、その `spritesheetPath` の spritesheet。1 マス 192×208 で 8 列）です。
- `avatar.json` を置くと、atlas（`atlas`・`animations`）、再生の速さ（`framesPerSecond`）、サーバーの表情から動作への対応表（`expressions`）を変えられます。
  書き方は同梱の [avatar.json](mac/Avatars/natsumi/avatar.json) を見てください。対応表にない表情は neutral の動作で表示します。
- 置いた後は、設定の「読み込み直す」で反映します。

## ライセンス

- コードは [MIT License](LICENSE) です。
- `mac/Avatars/` のアバターのアセットは [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) です。
  キャラクターの参照画像は Anima で、spritesheet は OpenAI の画像生成で作りました（[詳細](mac/Avatars/natsumi/README.md)）。

## 文書

- [設計 ADR](docs/adr/0001-server-and-data-ownership.md): データ所有権、[通信・承認](docs/adr/0002-client-events-and-approvals.md)、[外部連携](docs/adr/0003-assistance-and-integrations.md)、[Pi のツール・認証・音声](docs/adr/0004-pi-tool-and-voice-boundaries.md)、[サーバー基盤](docs/adr/0005-server-foundation.md)、[GitHub ログインと HTTPS/WSS](docs/adr/0006-github-login-and-transport.md)、[Let's Encrypt と固定 IPv6](docs/adr/0007-acme-and-fixed-ipv6.md)、[単一の思考ループと Mac との会話](docs/adr/0008-single-thinking-loop-and-mac-conversation.md)、[長期記憶と夜の session の切り替え](docs/adr/0009-long-term-memory-and-nightly-session-switch.md)、[Mac アプリの構成](docs/adr/0010-mac-app-structure.md)、[閉じ込めたコンテナで記憶を shell で探す](docs/adr/0011-memory-shell-in-a-confined-container.md)、[Slack 連携と同僚 AI](docs/adr/0012-slack-and-colleagues.md)、[本人が確かめたことをサーバーで持つ](docs/adr/0013-read-state-on-the-server.md)、[自分で予約する確認と定期の合図](docs/adr/0014-self-checks-and-pings.md)、[Mac の UI は一本の木の Passive View](docs/adr/0015-mac-ui-passive-view-tree.md)、[カードを開く操作とキャラクターの移動](docs/adr/0016-opening-a-card-and-moving-the-character.md)、[考えている 1 行を流す](docs/adr/0017-streaming-the-line-she-is-thinking.md)、[記憶を git で持ち、夜に組み直す](docs/adr/0018-memory-in-git-and-the-nightly-rebuild.md)、[記憶の道具をやめ、なつみの作業環境にする](docs/adr/0019-a-workspace-not-a-memory-tool.md)
- [サーバーと Mac の契約・実装順](docs/client-contract.md)
- [実接続の実行方法と結果](docs/probe-results.md)
- [設定例](config.example.json)（証明書ファイル）と [ACME の設定例](config.acme.example.json): 現在サーバーが受け付ける設定だけを載せています。後続の実装で項目を追加します。検証ハーネスはこのファイルを読みません。

個人 Markdown、SQLite、Pi の session・認証、ログ、private Wiki、証明書や secret はコード checkout の外に置きます。
ignore は事故防止の補助です。設定例を実環境に合わせたファイルは `config.local.json` として管理し、
秘密は環境変数や secret mount で渡します。個人データを公開 Git に保存しません。
