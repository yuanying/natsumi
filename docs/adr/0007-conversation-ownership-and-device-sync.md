# 0007. 会話の所有と端末間の同期

- Date: 2026-09-14
- Status: Accepted

## Context

ADR 0001 で全端末共通の永続 Pi session を一つ持つこと、ADR 0002 と [client-contract.md](../client-contract.md) で
操作表による重複排除、端末ごとの stream と snapshot による再同期を決めた。これを実装するにあたり、次が未決だった。

- Pi は session ファイルを最初の assistant 応答まで書き出さない。その前に止まると、SQLite の参照が存在しないファイルを指す
- 端末 ID をいつ・どう発行するか。再接続で差分を再送するか snapshot にするかの判定
- 「snapshot 中は新規 turn を保留」をどう実現するか
- 本文を保存しない操作表で、prompt 開始後に止まった操作をどう照合するか
- 設定からモデル接続先（subscription OAuth と OpenAI 互換エンドポイント）をどう選ぶか
- 性格設定をどう会話に渡すか

## Decision

### Pi session の所有

- SQLite の `conversations` に会話 ID・Pi session ID・session 保存先からの相対ファイル参照を一行だけ持つ。会話本文は置かない。
- 初回は Pi の session を作り、その header をすぐにファイルへ書いてから、復元と同じ検査（ファイルの存在、全行の JSON 構文、
  header と記録した session ID の一致）を通して開く。以後の起動もすべて同じ検査を通す。
- 参照があるのに検査に失敗した場合、または参照が保存先の外を指す場合は、新しい session を作らずに会話を `conversation-restore-failed` とする。
  モデルの認証や選択ができない場合は `pi-unavailable` とする。どちらでもサーバー自体は起動し、クライアントに `service.unavailable` で理由を示す。
- Pi にはツールを登録しない。compaction と自動 retry は無効のままとする。
- システム指示は固定の基本指示に data directory の `personality.md` を加えたものとし、起動時に一度だけ読む。変更の反映には再起動が要る。

### モデルの接続先

- `pi.model.provider` と `pi.model.id` で決める。provider が `natsumi-compatible` のときだけ `pi.compatible`（`baseUrl` と
  `apiKeyEnv` か `apiKeyFile`）を必須とし、それ以外の provider では `pi.compatible` を拒否する。暗黙のフォールバックはない。
- 互換エンドポイントの key はサーバーが起動時に参照先から読み、Pi には実行時の key として渡す。設定テンプレートとして解釈させないため、
  `$` や `!` を含む key もそのまま使われる。ADR 0004 の「Pi が要求時に参照する」はサーバーではこの形に置き換える。key の更新には再起動が要る。
- それ以外の provider は専用 Pi 領域の OAuth ログインだけを使う。ログインがなければ `pi-unavailable` とする。

### 端末と stream

- `deviceId` はサーバーが `session.sync` で発行し、`devices` 表に GitHub の数値 ID と直近のクライアントセッションとともに記録する。
  クライアントが示した ID は、同じアカウントに発行済みのものだけを使い続け、それ以外は採用せずに新しく発行する。認証の代わりにはしない。
- `session.sync` の前の会話 command は `sync-required`、接続に結び付いた端末と envelope の `deviceId` が違えば `device-mismatch` で拒否する。
  command ごとにセッションの期限を確かめ、切れていれば close code 1008 で閉じる。
- stream はプロセスの epoch ごと・端末ごとにメモリに持ち、直近の一定件数（既定 256 件）のイベントを保持する。
  全端末向けのイベントは、切断中の端末の stream にも採番して保持する。command の応答は送信した端末の stream だけに流す。
- 再同期では、epoch と streamId が一致し、指定の seq より後のイベントがすべてバッファに残っていれば、それを元の seq のまま再送し、
  続けて `command.accepted`（`mode: resume`）を返す。それ以外（epoch の変更、未発行の seq、バッファ切れ）は同じ stream に `session.snapshot` を発行する。
  snapshot 自身の seq が同期 barrier であり、以後のイベントはその上に適用する。
- 同じ端末の新しい接続は古い接続を close code 4001 で閉じる。送信待ちが大きく溜まった接続は 4002 で閉じ、再同期させる。

### snapshot

- snapshot は Pi のメモリ上の現在 branch と、進行中の item のそれまでのテキストから、一つの同期処理の中で作る。
  サーバーは単一スレッドで動くため、作成中に Pi のイベントや新しい turn の受理が割り込むことはない。
  これを「snapshot 中は新規 turn を保留」の実現方法とし、明示的な保留キューは持たない。
- 履歴の item は Pi の entry ID を持つ。進行中の item は natsumi が発行した itemId を持ち、確定時の `conversation.item.completed` で entry ID と対応付ける。
  送信者以外の端末にも本文を示すため、利用者のメッセージも確定時に `conversation.item.completed` として配信する。

### conversation.send の直列化と照合

- 操作は `accepted` で記録してから `command.accepted` を返し、その後に prompt を始める。Pi が利用者のメッセージを保存した時点で
  entry ID を記録して `prompted` にし、turn の終わりに `completed` / `failed` / `interrupted` にする。
- 同じ requestId は、本文の hash と端末が一致すれば既存の結果を返し、違えば `request-conflict` で拒否する。
  turn の進行中に別の requestId が来たら `busy` を返す。
- 起動時、`prompted` の操作は記録した entry の後の応答から結果を決める。`accepted` のまま止まった操作は、既に対応付けた最後の entry より後にある
  利用者の entry のうち、本文の hash が一致するものが一つだけあれば対応付ける。一致しない・複数ある場合は `unknown` とし、再送しない。
  `unknown` の操作は snapshot に示し、同じ requestId の再送には `operation-unknown` を返す。新しいメッセージの受付は妨げない。
- turn は最後の応答が正常に停止した場合だけ `completed` とする。明示の中断とサーバー停止は `interrupted`、
  長さ超過・モデルのエラー・10 分の期限切れは `failed` とし、`reason` に固定のコードだけを付ける。上流のエラー本文は送らない。

## Consequences

- 一度作った会話は、session ファイルを失うと手作業で復旧するまで使えない。黙って新しい会話になることはない。
- 性格設定と互換エンドポイントの key の変更は再起動で反映する。
- 同じ本文を続けて送った直後に止まると照合が曖昧になり、`unknown` になり得る。これは誤った対応付けより安全側に倒した結果である。
- 中断の要求が応答の完了とほぼ同時に届いた場合は、実際に完了していれば `completed` と報告する。
- snapshot は現在 branch の全履歴を含むため、会話が長くなるほど大きくなる。分割取得は必要になった時点で検討する。
- stream のバッファは端末数に比例してメモリを使う。承認待ち・通知待ちは、それらを実装する変更で snapshot に加える。
