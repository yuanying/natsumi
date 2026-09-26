# 0001. Pi を使う単一サーバーとデータの所有権

- Date: 2026-09-14
- Status: Accepted（会話の正本と SQLite に置く内容は [ADR 0008](0008-single-thinking-loop-and-mac-conversation.md) で置き換え。compaction の無効化は [ADR 0009](0009-long-term-memory-and-nightly-session-switch.md) で置き換え、session の割り当てと `memory/` の中身は同 ADR で具体化。保存先の表の Wiki は [ADR 0025](0025-talking-to-outside-agents-over-a2a.md) で置き換え）

## Context

複数の Mac から同じ個人アシスタントの会話と記憶を利用する。
コードの更新やコンテナの再作成で個人データを失わず、会話履歴の正本を一つに保つ必要がある。

## Decision

初期バックエンドは Pi Coding Agent のみとする。TypeScript サーバーへ
`@earendil-works/pi-coding-agent@0.87.1` の SDK を組み込む。
公式 npm package と同梱型・文書を基準にし、更新時は保存・再開とツール制限を再検証する。
Node 内で型付き API とツール登録を直接使えるため SDK を採用する。
RPC は他言語・子プロセス統合向けの選択肢として確認したが、この設計では採用しない。

Pi との接続箇所は session の作成/復元、prompt、中断、履歴、イベント購読を扱う小さな境界とする。
backend registry、別 backend adapter、切り替え UI は用意しない。
Pi 内の provider/model 設定はモデル接続先の選択であり、バックエンドの差し替えではない。
Mac は Swift/SwiftUI と AppKit を使い、常駐キャラクターのクリックで会話欄を開く。
キャラクター素材は未決定。サーバーは Linux コンテナを予定する。

全端末に共通の永続 Pi session を一つ割り当てる。会話の正本は Pi の session JSONL とし、
SQLite へ会話本文や assistant 応答を複製しない。
`SessionManager.create` / `open` で保存先を明示し、履歴は SDK の entry/branch API で取得する。
アプリの会話 ID と Pi session ID・相対 session ファイル参照の対応だけを SQLite に保存する。
任意のローカルパスを Mac から受け取る機能は設けない。

起動時の `--data-dir` を優先し、省略時は起動 cwd を data directory とする設計にする。
パスは起動時に絶対・実体パスに解決し、実行途中の cwd 変更に依存しない。
本番初期化ではコード checkout 内への個人データ配置を拒否する。

| 保存先 | 内容・所有者 | 復旧上の扱い |
| --- | --- | --- |
| data directory の `memory/` | 明示された記憶と重要情報を整理した Markdown。natsumi が所有 | 個人バックアップ。必要時だけ別 private Git |
| data directory の `personality.md` | 性格・話し方の設定 | 個人バックアップ |
| data directory の `.natsumi/state.sqlite` | session 参照、操作 ID、承認、スケジュール、通知。natsumi が所有 | 整合した SQLite バックアップ |
| 専用 Pi 状態領域の `sessions/` | Pi が所有する会話 JSONL | 永続 volume。SDK を通して扱う |
| 専用 Pi 認証領域の `auth.json` | Pi ModelRuntime が所有する OAuth 認証 | secret 管理。Markdown Git と分離 |
| 別 mount の private Wiki | Wiki 自身の規約に従う | Wiki 側のバックアップ |

サーバーは data directory のプロセスロックで二重起動を拒否する。
Pi の cwd は data directory、agentDir・session 保存先・authPath は専用領域に固定する。
既存の個人用 Pi の設定・履歴・認証と共有せず、本人が専用領域で login する。
Mac は Pi/Google credential とローカルパスを保持しない。

停止時は新規操作を止め、進行中の処理を完了または abort し、session を dispose する。
復旧時は保存したファイルが存在し JSONL 全非空行が解析できること、header と復元 session ID が一致することを検証する。
Pi が malformed 行を読み飛ばす動作をそのまま履歴復旧の成功とは扱わない。
保存参照があるのにファイルがない場合は復旧エラーとし、新規 session を作らない。
JSONL と SQLite の更新は原子的ではないため、結果不明操作の照合を別途行う。
バックアップはサーバー停止中に data directory と Pi session 領域を一組として取得する。

## Consequences

履歴の正本は一つになるが、サーバー停止中は新規会話を処理できない。
Pi は分岐・compaction を持つため、履歴 entry ID と現在の branch を区別する。
初期検証では compaction と自動 retry を無効にし、本体の有効化時に同期・復旧を試験する。
コンテナ再作成、Mac、本体バックアップ復旧は後続 PR の検証とする。
