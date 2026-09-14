# Codex App Server 検証

2026-09-14、Linux 上で Codex CLI **0.154.0**、Node.js **24.12.0**、npm **11.6.2** を使用した。
TypeScript は 5.9.3、`@types/node` は 24.10.1。検証ハーネスは CLI バージョンを固定して確認する。

## 再実行

通常検証:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

実接続は明示した次のコマンドだけで行う。既存 Plus 認証の `auth.json` を OS の
read-only mount またはサンドボックスで読み取り専用にした参照先を渡す。
下記パスは架空。通常の書き込み可能な認証ファイルは拒否する。
このために既存認証の権限・ログイン状態を変更したり、トークンをコピーしたりしない。
準備できなければ通常テストだけを実行し、実接続は未実施とする。

```sh
npm run probe:live -- --auth-ref /run/secrets/codex-auth.json
npm run probe:live -- --auth-ref /run/secrets/codex-auth.json --realtime
```

ハーネスは OS 一時ディレクトリに `natsumi-probe-*` を新規作成し、mode 0700 の
workspace と Codex home を使う。元の Codex 設定・MCP・履歴を読み込まず、
既存認証への symlink だけを作る。子プロセスへ環境変数を一括継承しない。
`account/read` は `refreshToken: false` とし、ChatGPT Plus 以外はモデル呼び出し前に拒否する。
認証参照が read-only なので、更新が必要な古い認証では失敗し得る。
自動 login、API key、別 provider への切り替えは行わない。

App Server は終了時に停止する。一時ディレクトリには合成会話の Codex 保存領域が残るため、
検証後はローカルの一時ファイル管理で削除する。実際の個人会話を指定するオプションはない。
出力は段階・判定・allowlist によるエラー分類だけで、thread ID、応答本文、生の上流エラー、音声データを出力しない。
認証パスも結果 JSON に含めない。正常なテキスト検証は exit 0、検証失敗・音声出力未確認は exit 1。

型の確認は実行に使う CLI 自身から行う。生成物は Git に入れない。

```sh
codex --version
codex app-server --help
codex app-server generate-ts --experimental --out /tmp/natsumi-protocol
```

## 実測結果

| 項目 | 結果 |
| --- | --- |
| 初期化・ChatGPT Plus 認証確認 | 成功。認証更新要求なし |
| `thread/start` | `ephemeral: false`、`historyMode: legacy` で作成成功 |
| 最初の `turn/start` | 架空の固定トークンへの assistant 応答と `turn/completed` の成功を確認 |
| `thread/read` | completed turn と assistant 応答を取得・検証 |
| App Server プロセス終了・再起動 | 同じ隔離 Codex home を使用して起動 |
| 再起動後 `thread/read` / `thread/resume` | 同一 thread / turn ID と元の assistant 応答を検証 |
| 再開後の会話 | 前のトークンを再提示せず「直前の応答を繰り返す」と要求し、同じトークンを応答。両 turn の履歴を検証 |
| `thread/realtime/listVoices` | RPC が応答。音声利用権限の証明にはしない |
| `thread/realtime/start` | websocket transport / audio output の開始 RPC を受理 |
| `appendAudio` / `appendText` | 24 kHz mono の合成無音 100 ms と架空テキストの RPC を受理 |
| realtime 音声出力 | `thread/realtime/error` を受信。音声出力は未確認。安全な分類は `unclassified-upstream-error` |
| `thread/realtime/stop` | cleanup RPC 成功 |

最終の音声付き検証は exit 1。テキストの永続性は成功し、音声は失敗として扱う。
この観測だけで原因を Plus の利用権限不足と断定しない。上流接続、実験的仕様、
アカウント条件のどれが原因かは未確定で、設定例では音声を無効のままにしている。
生のエラーを記録しない方針により、現時点の安全な分類以上の診断情報は残していない。

## 確認したプロトコルの境界

ローカル生成型では `thread/start`, `thread/read`, `thread/resume`, `turn/start` と
realtime の `start`, `appendAudio`, `appendText`, `appendSpeech`, `stop`, `listVoices` を確認した。
realtime は experimental API。`outputModality` は必須で、開始通知は startup の受理を表す。
audio chunk は base64 data、sampleRate、numChannels、samplesPerChannel、itemId を持つ。
`appendSpeech` は型確認だけで実行していない。WebRTC と existingCall transport も未検証。

公式の [App Server 文書](https://learn.chatgpt.com/docs/app-server) は
initialize/initialized の handshake と stdio の JSON メッセージ、thread/turn の操作を説明している。
本ハーネスの具体的なフィールドは実行した CLI の生成型を参照した。
公式の機能説明や型の存在を、独自 Linux/Mac アプリの音声動作保証として扱わない。

## 自動テストと未検証

fixture は断片化した stdio、応答の順序ずれ、早着通知、RPC エラー、切断、タイムアウト、
不正フレーム、通知 queue 上限、server request の拒否を検証する。
さらに履歴の ID・完了状態・assistant 応答の照合、Plus 以外の拒否、
音声 startup と出力成功の区別、エラー本文の非公開を確認する。

コンテナの build/再作成、Mac build と録音・再生、実音声の認識、ページ形式履歴、
本体の複数クライアント同期、GitHub 認証、通知、Calendar 承認、Google/Wiki 連携は未実装・未検証。
それぞれ [後続 PR の順序](client-contract.md#後続-pr-と検証順) で実装と試験を行う。
