# サーバーと Mac の契約 v1

これは後続実装の契約であり、このリポジトリの検証ハーネスが公開 API を提供するわけではない。
日時は UTC の RFC 3339、ID は内容を含まない opaque string とする。
Calendar の予定表現では UTC 時刻に加えて元の IANA timezone を保持する。
未知の protocol version は接続を拒否し、未知のイベント type は無視する。

## 接続と envelope

HTTPS の GitHub OAuth callback 後、短期セッションで WSS に接続する。
セッション失効・本人以外のアカウントは接続と全コマンドを拒否する。
Mac の `deviceId` はサーバー登録の ID であり、認証を代替しない。
方式の理由は [ADR 0006](adr/0006-github-login-and-transport.md) にある。

### ログインとセッション

Mac は `ASWebAuthenticationSession` を callback scheme `natsumi` で使う。

1. Mac が PKCE の verifier（43〜128 文字）と、アプリの state を生成する。
2. `GET /auth/github/start?code_challenge=<S256>&code_challenge_method=S256&state=<アプリの state>` を開く。
   サーバーは GitHub の認可画面へ redirect する。
3. 認可が済むと、サーバーは `natsumi://oauth/callback?code=<login code>&state=<アプリの state>` に redirect する。
   失敗の場合は `code` の代わりに `error` が付く。Mac は state が自分の生成したものと一致することを確かめる。
4. `POST /auth/session` に JSON で `code` と `codeVerifier` を送る。成功すると `token` と `expiresAt` が返る。
   login code は 60 秒で期限が切れ、1 回しか使えない（verifier が誤っていた場合も使えなくなる）。
5. 以後の HTTPS 要求と WSS の upgrade には `Authorization: Bearer <token>` を付ける。
   トークンは Keychain に保存する。期限（12 時間）が切れたら 1 からやり直す。
6. `POST /auth/logout`（Bearer 付き）でセッションを失効させる。成功すると 204 が返り、そのセッションの WSS は閉じられる。

| 経路 | 失敗時 | エラーコード |
| --- | --- | --- |
| `/auth/github/start` | 400 | `invalid-request`（challenge・method・state の不備）、429 `too-many-logins` |
| `natsumi://oauth/callback` の `error` | — | `login-expired`、`github-denied`、`github-exchange-failed`、`github-unavailable`、`account-not-allowed`、`invalid-request` |
| `/auth/github/callback` | 400 | `invalid-state`（state がない・一致しない・使用済み。アプリには戻らない） |
| `/auth/session` | 400 | `invalid-request`（形式の不備）、`invalid-grant`（未知・使用済み・期限切れ・verifier の不一致） |
| `/auth/logout` | 401 | `unauthorized` |

エラー応答は `{"error": "<コード>"}` だけで、上流の本文や秘密を含まない。

### WSS への接続

`wss://<publicOrigin のホスト>/v1/ws` に Bearer 付きで upgrade する。
セッションがない・失効・期限切れ・本人以外なら 401、Origin ヘッダーが `publicOrigin` と一致しなければ 403 を返し、接続を確立しない。
ネイティブクライアントは Origin を省略してよい。

クライアントのメッセージは 1 件ごとに `v` を検証する。`v` が 1 でなければ `command.rejected`（`unsupported-version`）を送り、
close code 1002 で閉じる。JSON のオブジェクトでなければ `invalid-envelope` を送り、1007 で閉じる。1 メッセージは 64 KiB までとする。
未知の `type` は無視する。セッションの失効・期限切れでは close code 1008 で閉じる（command を受けるたびに期限を確かめる）。
下表のうち `session.sync`・`conversation.send`・`conversation.interrupt` は実装済みで、それ以外の command は
`command.rejected`（`not-implemented`）を返す。`session.sync` の前の応答は、その接続だけの一時的な stream で採番する。
判断の理由は [ADR 0007](adr/0007-conversation-ownership-and-device-sync.md) にある。

```json
{"v":1,"requestId":"request-example","deviceId":"device-example","type":"conversation.send","payload":{"text":"架空のメッセージ"}}
```

サーバーイベントはプロセス起動ごとの `epoch`、登録端末ごとの `streamId`、
その stream 内で単調増加する `seq` を持つ。stream は同一 epoch 中の端末再接続をまたいで維持する。
全端末向けイベントにも各 stream で個別に採番し、端末限定イベントはその stream だけで採番する。
他端末への配信で自端末の seq は進まない。通知先の決定に使うサーバー操作順序は別の内部カウンターとする。
同じ deviceId から二重接続した場合は、新接続が旧接続を置き換える。
`requestId` は応答の相関に使い、購読者全体へのイベントでは省略できる。
内部のファイルパス、認証情報、Pi の session ファイル参照、任意の Pi SDK 呼び出しをクライアントに転送しない。

```json
{"v":1,"epoch":"epoch-example","streamId":"stream-example","seq":42,"type":"conversation.delta","payload":{"conversationId":"conversation-example","turnId":"turn-example","itemId":"item-example","text":"こんにちは"}}
```

`conversationId` と `turnId` は natsumi が採番する ID である。
`itemId` は確定後に Pi の session entry ID と対応付ける。Pi の session ID はクライアントに渡さない。

| クライアント command | payload | サーバーの結果 |
| --- | --- | --- |
| `session.sync` | `resume`: 前回の epoch/streamId/seq または null | 下記「端末の登録と stream」。承認待ちと未 ACK 通知は後続の実装で加える |
| `conversation.send` | text（32 KiB まで）、requestId | `command.accepted`（turnId、state）、または busy / request-conflict / operation-unknown / invalid-request |
| `conversation.interrupt` | 対象 turnId | 現在の turn の場合だけ `command.accepted`。別 turn・turn なしは turn-not-active |
| `approval.decide` | approvalId、revision、approve/reject | 確定した承認状態。内容・期限・権限を再検証 |
| `notification.ack` | notificationId | 全端末共通の ACK 状態 |
| `device.activity` | 明示操作の kind のみ | サーバー受理順で通知先更新。画面内容は含めない |

| サーバー event | 内容 |
| --- | --- |
| `session.snapshot` | deviceId、conversationId、`history`（Pi session の現在 branch から変換した履歴）、`activeTurn`（進行 turn と応答中 item のそれまでのテキスト、なければ null）、`operations`（進行中・結果不明の操作）。envelope の seq が snapshot の sequence。承認待ち・通知待ちは後続の実装で加える |
| `conversation.turn.started` | conversationId、turnId。envelope に対応 requestId |
| `conversation.delta` | conversationId、turnId、itemId、表示テキスト差分 |
| `conversation.item.completed` | conversationId、turnId、itemId、entryId、role（user / assistant）、確定した表示テキスト |
| `conversation.turn.completed` | conversationId、turnId、status（completed / failed / interrupted）。failed には reason（model-error / length / timeout / prompt-failed）。envelope に対応 requestId |
| `approval.pending` / `approval.resolved` | approvalId、revision、具体的変更内容または確定結果 |
| `notification.batch` | 通知 ID、作成時刻、内容または会話参照、遅延の有無 |
| `command.accepted` | command ごとの結果（`conversation.send` は turnId と state、`session.sync` の再送は deviceId と mode: resume） |
| `command.rejected` / `service.unavailable` | 安全なエラーコード。上流の生エラー本文は転送しない。`service.unavailable` の code は pi-unavailable / conversation-restore-failed / stopping |

### 端末の登録と stream

1. 接続後、最初に `session.sync` を送る。envelope の `deviceId` には前回サーバーから受け取った ID を入れる（初回は省略）。
   サーバーは同じアカウントに発行済みの ID だけを使い続け、それ以外なら新しい ID を発行して応答の `deviceId` で返す。
   Mac はこの ID を保存し、以後の command の envelope に付ける。
2. `payload.resume` に前回最後に受け取ったイベントの epoch・streamId・seq を入れる。同じ epoch・streamId で、その seq より後が
   サーバーのバッファに残っていれば、欠けたイベントが元の seq のまま届き、続けて `command.accepted`（mode: resume）が届く。
3. それ以外の場合は `session.snapshot` が届く。Mac は表示をこの snapshot で置き換え、以後はこれより大きい seq のイベントを適用する。
   `activeTurn` の item のテキストには、snapshot より後の `conversation.delta` を連結してよい。
4. 会話が使えない場合は `service.unavailable` が届く（deviceId も付く）。
5. 同期の前の会話 command は `sync-required`、接続の端末と異なる `deviceId` の command は `device-mismatch` で拒否される。
6. 同じ端末で新しく接続すると古い接続は close code 4001 で閉じられる。受信が大きく遅れた接続は 4002 で閉じられるので、再接続して同期する。

イベントのバッファはサーバーのメモリにあり、既定では stream ごとに直近 256 件である。サーバーの再起動で epoch が変わる。

## 会話の直列化と再同期

一つの会話に同時に開始する turn は一つとする。割り込みは明示 command に限る。
SQLite の操作表には requestId、端末 ID、本文の hash、状態、turnId、対応する Pi の user entry ID を保存する。
同じ requestId で別の hash（または別の端末）が来たら `request-conflict` で拒否する。本文は保存せず、受理確認まで Mac が保持する。
操作の状態は accepted → prompted（user entry ID を保存）→ completed / failed / interrupted と進み、照合できないものは unknown になる。
natsumi が turnId を採番して `accepted` 状態を保存してから `command.accepted` を返し、その後 Pi に prompt を渡す。
同一 requestId の再送は既存結果を返す。処理中・結果不明なら新しい prompt を開始しない。
Pi は requestId を idempotency key として扱わない。
prompt 開始後、user entry ID を保存する前に障害が起きた場合は、Pi session の履歴と照合してから解決する。
照合できなければ operation-unknown として本人に状態を示し、自動再送しない。
Pi の assistant 応答は stop 以外（error / aborted / 長さ超過など）を completed として扱わない。

ライブイベントは端末の stream ごとにメモリ内の有限バッファに保つ。会話本文の永続 outbox は作らない。
同一 epoch/streamId かつ必要な seq がその stream のバッファに残っていれば差分を再配信できる。
epoch/streamId が変わった、その stream の seq が抜けた、受信が遅くバッファを超えた場合は snapshot を要求する。
stream を破棄・再作成する場合は新しい streamId を発行し、同じ ID で seq をリセットしない。

snapshot 中は新規 turn の受理を保留し、Pi session のイベントを購読したままバッファへ取り込む。
履歴取得とイベントの原子的 snapshot API は仮定しない。現在の実装は Pi のメモリ上の branch と進行中 item の状態から
一つの同期処理で snapshot を作るため、その間にイベントや turn の受理が割り込まない（ADR 0007）。
履歴の確定 entry は entry ID で upsert し、取得中に進行した item は確定時に本文を置き換える。
進行 item の delta に整合した開始点が得られなければ、その item は「応答中」と表示して
completed event または再取得を待つ。snapshot の本文へ既存 delta を盲目的に連結しない。
Pi の branch や compaction で表示対象が変わる場合は、entry ID ではなく現在 branch を基準に snapshot を作り直す。
同期対象端末の stream に新しい同期 barrier の seq を発行してから通常配信と turn 受理を再開する。
Mac 再起動時はサーバーの snapshot を正とし、永続的な独自会話 DB は持たない。

## 承認と外部実行

承認レコードは approvalId、revision、対象 calendar/event ID、変更前 ETag、変更後の全項目、
期限、payload hash、状態、実行 operation ID を持つ。
許可画面と実行 payload は同じ immutable revision から生成する。
`pending -> approved/rejected` は transaction の条件付き更新とし、重複回答は確定状態を返す。
実行直前に期限、対象 ETag、hash、操作種別を再確認する。変更があれば再承認へ戻す。
削除、招待、参加者変更、通知メール送信は実行 adapter で拒否する。

Calendar 実行は `approved -> executing -> succeeded/failed/unknown` と進める。
作成では provider が許す決定的 event ID、更新では ETag 条件を使う方針とし、
Google API の制約は adapter 実装時に検証する。
外部実行成功後・ローカル保存前の停止は `unknown` として外部の結果を照合する。
実行要求を無条件で再送して二重作成しない。
Pi の `calendar_propose` ツール呼び出しは承認待ちの作成要求にすぎず、承認や実行の許可として扱わない。

## 通知と定期処理

通知には全端末共通の notificationId を付ける。サーバーの配信 transaction は対象端末と
期限付き lease を保存する。ACK 前の切断や lease 満了は未配信扱いへ戻し、次の端末へ再配信する。
ACK は通知 ID で冪等に記録し、古い端末からの遅延 ACK も同一通知の受領として扱う。
クライアントは表示済み通知 ID のみをローカルに保持し、本文を再度ポップアップしない。
別端末への重複到着は起こり得るため、ACK 済み状態を全端末へ同期する。
全端末オフラインでも通知は SQLite に残し、次回接続時にまとめて表示する。
配信対象は最後の明示操作のサーバー順序で決め、クライアント時計を信頼しない。

## 後続 PR と検証順

1. **基盤**: 設定 parser、初期化、data directory ロック、SQLite migration、専用 Pi 状態領域
   （agentDir・session・auth）、GitHub 認証、TLS 接続、コンテナ永続化。本人以外の拒否と二重起動拒否を試験する。
   `docker compose config --quiet` / `docker compose build` を実装時に実行する。
2. **会話・記憶・通知**: 永続 Pi session の所有権、履歴変換、上記同期、Markdown 記憶、
   スケジューラー、通知 lease。複数端末、切断、プロセス停止、ACK 消失を試験する。
3. **外部連携**: Gmail 読み取り、Calendar 提案・承認・実行、Wiki fixture。
   承認前未実行、revision 不一致、二重承認、外部結果不明の照合、既存 Wiki 差分の保護を試験する。
4. **Mac UI**: SwiftUI/AppKit 常駐、会話、承認表示、通知。Xcode scheme と具体的な
   `xcodebuild` build/test コマンドを決め、対応 Mac 上で実行する。
5. **運用・音声**: コンテナ再作成とバックアップ復旧、複数 Mac の実接続、音声の再検討。
   音声は対応方式・利用条件・課金条件と Mac の録音・再生・中断を確認できた場合だけ別途判断する。
