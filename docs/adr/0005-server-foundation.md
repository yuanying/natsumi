# 0005. サーバー基盤の設定・ロック・状態 DB・コンテナ

- Date: 2026-09-14
- Status: Accepted（listener とポートの公開は [0006](0006-github-login-and-transport.md) で更新）

## Context

ADR 0001 で、data directory、プロセスロックによる二重起動の拒否、`.natsumi/state.sqlite`、
専用の Pi 状態領域を決めた。これらを実装するにあたり、設定の形式、ロックの実現方法、
SQLite の実装、コンテナの構成を決める必要がある。
サーバーは 1 ユーザー・1 インスタンスで、コンテナの再作成やプロセスの異常終了のあとも
手作業なしに安全に再起動できなければならない。
クライアント認証（GitHub OAuth）と HTTPS/WSS の listener は後続の変更で入る。

## Decision

### 設定

設定は JSON ファイル 1 つとし、`serve --config` で渡す（省略時は起動 cwd の `config.local.json`）。
起動時に全体を検証し、問題があれば `pi.authPath` のような設定名と理由を示して起動を止める。
エラーに設定値は含めない。

- 未知の設定名は無視せず拒否する。綴り間違いで安全側の設定が黙って無効になるのを防ぐ。
- 秘密は設定に書かない。名前が `...Env` の項目は環境変数名、`...File` の項目は secret mount の絶対パスだけを受け付ける。
  secret・token・password・API key・credential を名前に含む項目へ値を直接書いた場合や、
  既知のトークン形式・秘密鍵ヘッダーに見える文字列は、どの項目でも拒否する。
  これは事故防止の補助であり、あらゆる秘密の検出を保証するものではない。
- data directory は ADR 0001 のとおり `--data-dir` か起動 cwd で決め、設定には書かない。
- 設定は節ごとの parser の集まりとして実装する。GitHub 認証や接続の設定は、節を追加して拡張する。
  初期の設定例には実装済みの `pi` 節だけを載せる。
- 音声は ADR 0004 のとおり未対応のため、`pi.voiceEnabled` は `false` だけを受け付ける。

### data directory と Pi 状態領域

- data directory は起動時に実体パスへ解決し、存在しなければ作成せずに拒否する（パスの誤記で空の領域を作らない）。
- 自身または祖先に `name` が `natsumi` の `package.json` がある場合はコード checkout とみなして拒否する。
  data directory 自体が private Git リポジトリであることは許可する。
- 初期化では `memory/`・`.natsumi/`（0700）と `personality.md`（0600）を、存在しないときだけ作る。
  既存のファイルの内容と権限は変更しない。サーバーは umask 077 で動く。
- Pi の agentDir・session 保存先・authPath の親ディレクトリを 0700 で作る。認証ファイル自体は作らない。
  これらが data directory と重なる場合、ホームの `.pi` / `.codex` 配下にある場合、コード checkout 内にある場合は拒否する。
  サーバーは `PI_CODING_AGENT_DIR` を設定の agentDir に向け、個人の Pi 既定領域を使わない。

### プロセスロック

`.natsumi/server.lock` を SQLite で開き、排他ロック（`BEGIN EXCLUSIVE`、待ち時間 0）をプロセスの生存中保持する。
取得できなければ「すでに起動している」として起動を止める。

PID ファイル方式は採用しない。コンテナでは PID が 1 に揃いやすく、PID の再利用もあり、
古いロックかどうかの判定を誤りやすい。SQLite のロックは OS の POSIX advisory lock であり、
プロセスが異常終了すればカーネルが解放するため、古いロックの手動削除も判定も要らない。
同じ volume を共有するコンテナ同士でも、同一ホストのローカルファイルシステム上なら排他が効く。
ロック用ファイルに SQLite 以外の内容があれば、空きとはみなさず起動を止める。

### 状態 DB と migration

SQLite には Node 24 標準の `node:sqlite` を使う。ネイティブアドオンのビルドや追加の依存が不要で、
コンテナとローカルで同じ実装になる。Node 24.12 では experimental 扱いで起動時に警告が出るため、
Node の更新時に API の変更がないか確認する。

- DB は WAL・外部キー有効で開く。
- migration は version（正の整数、厳密に増加）・名前・SQL の組を順に並べる。
  適用済みのものは `schema_migrations` に記録し、再実行しても何もしない。
- 各 migration は記録行と同じ transaction で適用する。失敗した migration は丸ごとロールバックし、記録も残さない。
- DB にコードの知らない version がある場合、または適用済みの名前が一致しない場合は起動を止める。
  リリースした migration は書き換えず、新しい migration を追加する。
- 初期スキーマは、ADR 0001 と client-contract で形が決まっている会話の対応表（アプリの会話 ID、
  Pi session ID、session 保存先からの相対ファイル参照）と `conversation.send` の操作表（request ID、端末 ID、
  本文の hash、状態、turn ID、Pi の user entry ID）に限る。会話本文を保存する列は作らない。
  承認・スケジュール・通知・端末は、それを使う処理を実装する変更で migration として追加する。

### 起動・停止・ヘルスチェック

起動は「設定の検証 → data directory の解決と初期化 → ロック → migration → Pi 状態領域の準備」の順とし、
途中で失敗したら開いた DB とロックを解放して終了する。SIGTERM / SIGINT で状態を stopped に更新し、
DB を閉じてロックを解放してから終了する。二度目のシグナルでは即座に終了する。

認証がまだないため、ネットワークの listener は開かない。ヘルスチェックは
`.natsumi/status.json`（状態と定期更新するハートビート時刻）を読む `health` サブコマンドで行う。
ヘルスチェックがロックを取りに行くと、起動中のサーバーと競合し得るため、ロックは使わない。

### コンテナ

- `node:24.12.0-bookworm-slim` を固定し、ビルド段階と実行段階を分ける。実行イメージは本番依存とビルド結果だけを持つ。
- 非 root の `node` ユーザーで動かし、ルートファイルシステムを読み取り専用、全 capability を削除、
  `no-new-privileges` とする。
- data directory（`/data`）と Pi 状態領域（`/var/lib/natsumi-pi`）は別々の named volume に置き、コードと分ける。
  マウント先はイメージ内で `node` 所有・0700 にしておき、新しい named volume がその所有者と権限を引き継ぐ。
- 設定ファイルは読み取り専用で bind mount する。秘密は環境変数か Compose の secrets で渡す。
- ポートは公開しない。

## Consequences

- 異常終了後の再起動に手作業が要らない一方、ロックは POSIX lock が正しく動くファイルシステムを前提とする。
  NFS などネットワーク越しの共有ストレージに data directory を置く構成は保証しない。
- 未知の設定を拒否するため、後続の変更で設定項目を追加するときは parser と設定例を同時に更新する必要がある。
- `node:sqlite` の experimental 警告が起動ログに出る。Node の更新は API 互換性の確認を伴う。
- 状態 DB は会話本文を持たないため、会話の復旧は Pi session に依存する（ADR 0001）。
- 既存のディレクトリを bind mount する場合、所有者をコンテナの `node` ユーザー（UID 1000）に合わせる必要がある。
- コンテナの再作成とバックアップからの復旧は後続の運用検証で試験する。
