# 0001. 単一サーバーとデータの所有権

- Date: 2026-09-14
- Status: Accepted

## Context

複数の Mac から、同じ個人アシスタントとの会話と記憶を利用する。
公開コードの更新やコンテナの再作成で個人データを失わず、会話履歴の正本を一つに保つ必要がある。

## Decision

TypeScript サーバーが一人分の状態と Codex App Server 子プロセスを所有する。
Mac は Swift/SwiftUI と AppKit を用い、常駐キャラクターのクリックで会話欄を開く。
キャラクター素材は未決定。サーバーは Linux コンテナを予定する。

全端末に共通の永続 Codex thread を一つ割り当てる。会話履歴の正本は Codex とし、
natsumi の SQLite には会話本文・応答履歴を複製しない。
thread ID、操作 ID、承認待ち、スケジュール、通知配信状態は natsumi が管理する。
初期の検証ハーネスは `historyMode: legacy` を明示する。
本体では履歴の増大に備えて paginated モードと turns/items ページ API を別途検証する。

起動時に指定する data directory はコードの checkout と分離する。
本体の CLI は `--data-dir` 指定を優先し、省略時は起動時の cwd を採用する設計とする。
パスは起動時に絶対パス・実体パスへ解決し、実行途中の cwd 変更に依存しない。
本番初期化ではコード checkout 内への個人データ配置を拒否する。

| 保存先 | 内容・所有者 | 復旧上の扱い |
| --- | --- | --- |
| data directory の `memory/` | 明示された記憶と、会話から重要と判断した情報を整理した Markdown。natsumi が所有 | 個人バックアップ対象。必要なら別の private Git |
| data directory の `personality.md` | 性格・話し方の設定 | 個人バックアップ対象 |
| data directory の `.natsumi/state.sqlite` | thread ID、操作、スケジュール、承認、通知。natsumi が所有 | SQLite の整合したバックアップ |
| 専用 `CODEX_HOME` | Codex が所有する会話・索引・設定・認証 | 永続 volume。内部 DB を natsumi から編集しない |
| 別 mount の private Wiki | Wiki 自身の規約に従う | Wiki 側のバックアップ |

サーバー起動時は data directory のプロセスロックを取得し、二つ目のインスタンスを拒否する。
App Server の cwd と thread の cwd は data directory に固定する。
既存の個人用 Codex home を本体と共有せず、専用の認証・状態領域を用意する。
Mac は Codex 認証、Google 認証、サーバー上のファイルパスを保持しない。

停止時は新規操作を止め、進行中の操作状態を確定してから App Server を終了する。
復旧時は SQLite の thread ID を `thread/read` と `thread/resume` で照合する。
ID があるのに履歴が見つからない場合は復旧エラーとし、黙って別 thread を作らない。
初期作成の応答後・ID 保存前に停止した場合も、既存候補の照合が必要であり自動再作成しない。
バックアップはサーバー停止中に data directory と Codex home を一組として取得する。
認証のバックアップは通常の Markdown Git と分離し、秘密管理の対象にする。

## Consequences

Mac 間で履歴の競合を解決する必要がなくなる一方、サーバー停止中は新規会話を処理できない。
Codex の保存形式には依存せず、履歴取得 API を境界とする。
音声は実験的なため、利用可能性を別に判定する。
本体・コンテナ・Mac の実装と復旧試験は後続 PR で行う。
