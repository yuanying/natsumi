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
下表のうち `session.sync`・`conversation.send`・`conversation.read`・`notification.ack` は実装済みで、それ以外の command は
`command.rejected`（`not-implemented`）を返す。`session.sync` の前の応答は、その接続だけの一時的な stream で採番する。
会話の扱いの理由は [ADR 0008](adr/0008-single-thinking-loop-and-mac-conversation.md)、
既読と知らせの確認の理由は [ADR 0013](adr/0013-read-state-on-the-server.md) にある。

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
{"v":1,"epoch":"epoch-example","streamId":"stream-example","seq":42,"type":"conversation.message","payload":{"messageId":"message-example","role":"natsumi","kind":"reply","text":"こんにちは","replyTo":"event-example","createdAt":"2026-01-01T00:00:00.000Z"}}
```

`messageId` と `eventId` は natsumi が採番する ID である。Pi の session ID・entry ID・思考・ツールの呼び出しはクライアントに渡さない。

| クライアント command | payload | サーバーの結果 |
| --- | --- | --- |
| `session.sync` | `resume`: 前回の epoch/streamId/seq または null | 下記「端末の登録と stream」。承認待ちは後続の実装で加える |
| `conversation.send` | text（32 KiB まで、空白だけは不可）、requestId | `command.accepted`（messageId、eventId、state）、または request-conflict / invalid-request / `service.unavailable` |
| `conversation.read` | throughMessageId（会話の messageId） | `command.accepted`（readThroughMessageId、unreadReplyCount。手前の位置なら今の位置）、または invalid-request / `service.unavailable`。下記「既読と知らせの確認」 |
| `conversation.interrupt` | — | 受け付けない（`not-implemented`）。進行中の思考は外から止めない |
| `approval.decide` | approvalId、revision、approve/reject | 確定した承認状態。内容・期限・権限を再検証（未実装） |
| `notification.ack` | notificationId（知らせの messageId） | `command.accepted`（notificationId、acknowledgedAt。2 回目以降も最初の時刻）、または invalid-request / `service.unavailable` |
| `device.activity` | 明示操作の kind のみ | サーバー受理順で通知先更新。画面内容は含めない（未実装） |

| サーバー event | 内容 |
| --- | --- |
| `session.snapshot` | deviceId、`messages`（本人に見せる会話。古い順で直近 500 件）、`pendingEvents`（処理を待つ・処理中の本人のメッセージ: eventId、messageId、state）、`avatar`（expression）、`readThroughMessageId`（既読カーソル。無ければ null）、`unreadReplyCount`（未読の返事の数。500 件の外も数える）、`unacknowledgedNotificationIds`（未確認の知らせの messageId をすべて古い順に。500 件の外も含む）。envelope の seq が snapshot の sequence。承認待ちは後続の実装で加える |
| `conversation.read` | readThroughMessageId、unreadReplyCount。カーソルが進んだときだけ全端末に届く |
| `notification.acked` | notificationId、acknowledgedAt。知らせを初めて確認したときだけ全端末に届く |
| `conversation.message` | messageId、role（owner / natsumi）、kind（message / reply / notice）、text（全文）、createdAt。message は eventId、reply は replyTo（答えたイベント）、notice は関係するイベントがあれば about |
| `avatar.expression` | expression（neutral / happy / laughing / surprised / thinking / worried / sad / sleepy） |
| `conversation.event.completed` | eventId、messageId、status（replied / no-reply / failed）。failed には reason（model-call-limit / timeout / model-error / stopped） |
| `approval.pending` / `approval.resolved` | approvalId、revision、具体的変更内容または確定結果 |
| `notification.batch` | 未実装で、送られない。知らせは `conversation.message`（kind: notice）で届く。下記「通知と定期処理」 |
| `command.accepted` | command ごとの結果（`conversation.send` は messageId・eventId・state、`session.sync` の再送は deviceId と mode: resume） |
| `command.rejected` / `service.unavailable` | 安全なエラーコード。上流の生エラー本文は転送しない。`service.unavailable` の code は pi-unavailable / conversation-restore-failed / stopping |

### 端末の登録と stream

1. 接続後、最初に `session.sync` を送る。envelope の `deviceId` には前回サーバーから受け取った ID を入れる（初回は省略）。
   サーバーは同じアカウントに発行済みの ID だけを使い続け、それ以外なら新しい ID を発行して応答の `deviceId` で返す。
   Mac はこの ID を保存し、以後の command の envelope に付ける。
2. `payload.resume` に前回最後に受け取ったイベントの epoch・streamId・seq を入れる。同じ epoch・streamId で、その seq より後が
   サーバーのバッファに残っていれば、欠けたイベントが元の seq のまま届き、続けて `command.accepted`（mode: resume）が届く。
3. それ以外の場合は `session.snapshot` が届く。Mac は表示をこの snapshot で置き換え、以後はこれより大きい seq のイベントを適用する。
4. 会話が使えない場合は `service.unavailable` が届く（deviceId も付く）。
5. 同期の前の会話 command（`conversation.send`・`conversation.read`・`notification.ack`）は `sync-required`、
   接続の端末と異なる `deviceId` の command は `device-mismatch` で拒否される。
6. 同じ端末で新しく接続すると古い接続は close code 4001 で閉じられる。受信が大きく遅れた接続は 4002 で閉じられるので、再接続して同期する。

イベントのバッファはサーバーのメモリにあり、既定では stream ごとに直近 256 件である。サーバーの再起動で epoch が変わる。

## 会話の記録と再同期

natsumi は一本の思考ループで、本人のメッセージを 1 件ずつイベントとして処理する（ADR 0008）。

1. `conversation.send` を受けると、サーバーは requestId・端末 ID・本文とイベントを SQLite に記録してから、送信した端末に `command.accepted` を返す。
   同じ requestId の再送には同じ messageId・eventId と現在の state（queued / processing / replied / no-reply / failed）を返し、
   本文か端末が違えば `request-conflict` で拒否する。処理中でも busy にはならず、次の境目で差し込まれるか順番を待つ。
2. 続けて全端末に、本人のメッセージの `conversation.message` と、`avatar.expression`（thinking）が届く。
3. natsumi が返事を確定すると、全文の `conversation.message`（kind: reply）が一度だけ届く。1 つのメッセージへの返事は最大 1 回である。
   相談や知らせは kind: notice で届く。途中の文字列は流れない。
4. 処理が終わると `conversation.event.completed` が届く。返事なしで終わることもある（no-reply）。
   表情がサーバーの出した thinking のままなら、neutral の `avatar.expression` が続く。

`session.snapshot` の `messages` は SQLite の記録から作る。natsumi の思考、内心、ツールの呼び出しは含まれない。
サーバーを再起動しても同じ履歴が返る。再起動の前に処理中だったメッセージは二度処理せず、返事がなければ failed になる。

natsumi は毎晩決まった時刻に一日を振り返り、思考の記録を新しくする（ADR 0009）。Mac から見える変化は次のとおりである。

- 振り返りの間、`avatar.expression` は sleepy になる。
- その間に送ったメッセージも受け付けられ（state は queued）、全端末に表示される。表情は thinking にならない。
  返事は振り返りが終わってから届く。
- 振り返りそのものは会話に出ない。振り返りに対する `conversation.event.completed` も届かない。
- 終わると、待っているメッセージがあれば thinking、なければ neutral の `avatar.expression` が届く。
- 会話の履歴（snapshot）は、振り返りと記録の切り替えで変わらない。

ライブイベントは端末の stream ごとにメモリ内の有限バッファに保つ。
同一 epoch/streamId かつ必要な seq がその stream のバッファに残っていれば差分を再配信できる。
epoch/streamId が変わった、その stream の seq が抜けた、受信が遅くバッファを超えた場合は snapshot を要求する。
stream を破棄・再作成する場合は新しい streamId を発行し、同じ ID で seq をリセットしない。
snapshot はサーバーの一つの同期処理で作るので、その間にイベントは割り込まない。snapshot より大きい seq のイベントをその上に適用する。
Mac 再起動時はサーバーの snapshot を正とし、永続的な独自会話 DB は持たない。

## 既読と知らせの確認

本人が確かめたことはサーバーが持ち、すべての端末で共通である（ADR 0013）。Mac は既読や確認の記録を独自に保存しない。

返事の既読は、会話の位置のカーソル 1 つで表す。

- `conversation.read` の throughMessageId までの返事を読んだことにする。本人のメッセージ・返事・知らせのどれを指してもよい。
- カーソルは戻らない。今の位置より手前を送っても変わらず、`command.accepted` で今の位置が返る。
- 未読の返事は、カーソルより後にある kind: reply のメッセージである。本人のメッセージは数えない。カーソルが null なら、すべての返事が未読である。
- カーソルが snapshot の `messages` の中に無ければ、カーソルは一覧より古い。一覧の返事はすべて未読で、件数は `unreadReplyCount` を使う。
- 本人がメッセージを送っても、カーソルは自動では進まない。

知らせの確認は、知らせ（kind: notice）1 件ずつで表す。

- `notification.ack` の notificationId は、知らせの messageId である。順不同で確認できる。
- 冪等で、2 回目以降は最初に記録した acknowledgedAt が返る。知らせでない ID と存在しない ID は invalid-request になる。
- カーソルが知らせを越えても、知らせは確認済みにならない。

反映の順序は次のとおりである。

1. 送った端末に `command.accepted` が届く。
2. 状態が変わった場合だけ、送った端末を含む全端末に `conversation.read` または `notification.acked` が届く。
   手前の位置や 2 回目の ack では、イベントは届かない。
3. これらのイベントも stream の seq で採番され、差分の再送に含まれる。snapshot を受け取った端末は、snapshot の 3 つの項目で状態を置き換える。

サーバーを更新して既読の記録を初めて持ったとき、それまでの会話はすべて既読・確認済みになる。以後の返事と知らせだけが未読になる。

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

通知は、会話の知らせ（`conversation.message` の kind: notice）である（ADR 0008・0013）。

- 知らせは SQLite の会話に記録し、全端末に `conversation.message` で届く。notificationId は知らせの messageId である。
- 本人の確認は `notification.ack` で知らせごとに冪等に記録し、`notification.acked` で全端末へ同期する。古い端末からの遅れた ACK も同じ知らせの確認として扱う。
- 全端末がオフラインでも知らせは残る。次に接続した端末は、snapshot の `unacknowledgedNotificationIds` で未確認の知らせを知る。
- 表示済みかどうかをクライアントが独自に保存する必要はない。確認の状態はサーバーのものを使う。

次は作っておらず、未定である。

- 配信先の決定（最後の明示操作の端末だけに送る）、期限付きの lease、ACK が無いときの別の端末への再配信
- `notification.batch` と `device.activity`
- 時刻に合わせた知らせと、確かめていない知らせの念押し（スケジューラーの作業で決める）

## 後続 PR と検証順

1. **基盤**: 設定 parser、初期化、data directory ロック、SQLite migration、専用 Pi 状態領域
   （agentDir・session・auth）、GitHub 認証、TLS 接続、コンテナ永続化。本人以外の拒否と二重起動拒否を試験する。
   `docker compose config --quiet` / `docker compose build` を実装時に実行する。
2. **会話・記憶・通知**: 単一の思考ループと表示用の会話の記録（ADR 0008、実装済み）、上記同期、
   Markdown 記憶と夜の session の切り替え（ADR 0009、実装済み）、既読と知らせの確認（ADR 0013、実装済み）、スケジューラー。複数端末、切断、プロセス停止、ACK 消失を試験する。
3. **外部連携**: Gmail 読み取り、Calendar 提案・承認・実行、Wiki fixture。
   承認前未実行、revision 不一致、二重承認、外部結果不明の照合、既存 Wiki 差分の保護を試験する。
4. **Mac UI**: SwiftUI/AppKit 常駐、会話、承認表示、通知。Xcode scheme と具体的な
   `xcodebuild` build/test コマンドを決め、対応 Mac 上で実行する。
5. **運用・音声**: コンテナ再作成とバックアップ復旧、複数 Mac の実接続、音声の再検討。
   音声は対応方式・利用条件・課金条件と Mac の録音・再生・中断を確認できた場合だけ別途判断する。
