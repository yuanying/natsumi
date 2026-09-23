# 0029. iPhone に通知を届ける

- Date: 2026-09-23
- Status: Accepted

## Context

iPhone のアプリは、裏に回ると接続を切る（[ADR 0028](0028-the-iphone-client.md) の 4）。そのため、アプリを開くまで
natsumi の返事にも知らせにも気づけない。ADR 0028 は、裏にいる間の通知（APNs）を範囲外としていた。
[ADR 0013](0013-read-state-on-the-server.md) も、特定の端末だけで目立たせる必要が出たら決め直すとしていた。

これまでの署名は無料の Apple ID だった。APNs の entitlement と、サーバーが APNs に送るための鍵（.p8）には、
有料の Apple Developer Program が要る。今回はそれを使う。

会話の中身は本人とサーバーの間のものである。APNs の payload は Apple のサーバーを通り、ロック画面にも出る。

## Decision

### 1. iPhone に、返事と知らせを通知する

- 通知するのは、natsumi の返事（`reply_to_mac`）と知らせ（`notify_owner`）である。本人のメッセージは通知しない。
- 承認は、まだサーバーに実装されていない（`approval.decide` は断る）。承認待ちの通知は、承認を実装する変更で足す。
  通知の種類は後から足せる形にしておく。
- Mac には送らない。Mac アプリは常駐していて、接続したまま知らせを出している。

### 2. その iPhone がつながっていなければ、送る

- 返事や知らせを記録したとき、登録のある端末のうち、いま接続していない端末へ送る。接続していれば、
  会話のイベントとして届くので送らない。
- Mac で見ていても iPhone は鳴る。本人が Mac で読んだり確かめたりしたら、iPhone の通知を片づける（5）。
  Mac で操作しているかどうか（`device.activity`）では絞らない。単純で、取りこぼしがないからである。
- 音はいつも標準の音にする。サーバーは時間帯を見ない。夜は iOS の集中モードや睡眠に任せる。

### 3. 本文は端末の公開鍵で暗号化し、端末で復号する

- iPhone は、通知のための P-256 の鍵ペアを作り、秘密鍵を Keychain に置く。アプリと Notification Service Extension は、
  Keychain の access group でこの秘密鍵を共有する。
- サーバーは、送るたびに一時的な鍵ペアを作り、次の手順で本文を暗号化する。
  - 一時的な秘密鍵と端末の公開鍵で ECDH を取る。
  - 鍵は HKDF-SHA256 で導く。salt は一時的な公開鍵と端末の公開鍵（どちらも X9.63 の非圧縮形式）をこの順につないだもの、
    info は `natsumi-push-v1`、長さは 32 バイトとする。
  - AES-256-GCM で暗号化する。nonce は 12 バイトの乱数、AAD は messageId とする。
  - 平文は `{ "text", "expression" }` の JSON とする。payload の 4KB に収まるよう、暗号化の前に本文を 1000 文字で切る。
- payload の中身は次のとおりとする。
  - `aps.alert`: 決まった文（タイトル「なつみ」、本文「返事があります」または「知らせがあります」）。
    復号に失敗したときは、この文がそのまま出る。
  - `aps.mutable-content`: 1
  - `aps.badge`、`aps.sound`: default
  - 平文のまま置くもの: `messageId`、`kind`（reply / notice）、`position`。どれも会話の中身ではなく、片づけに使う。
  - 暗号文: `e`。中身は `{ v: 1, epk, nonce, ct }` で、どれも base64 とする。
- Extension は `e` を復号し、本文とセリフの気持ちの顔で通知を書き換える。
- サーバーは端末の秘密を持たない。送るのに要るのは公開鍵だけである。

### 4. 登録は WebSocket の契約で行う

- v1 の契約に command `push.register` を足す。引数は `token`（APNs の device token）、`publicKey`（X9.63 の base64）、
  `environment`（`sandbox` または `production`）とする。
- iPhone は、`session.sync` の後、接続のたびに送る。token は変わり得るので、登録は冪等に上書きする。
- 登録は端末（deviceId）ごとに 1 つとし、SQLite の新しい migration で持つ。その端末のセッションが失効したり
  取り消されたりしたら、送らない。ログアウトもセッションの取り消しなので、同じく送らなくなる。
- `environment` で送り先（`api.sandbox.push.apple.com` か `api.push.apple.com`）を選ぶ。Debug で build したものは
  sandbox、配布したものは production になる。

### 5. バッジは未読の数にし、読んだら片づける

- バッジは、未読の返事の数と未確認の知らせの数の和とする。送るときに数えて `aps.badge` に入れる。
- 既読のカーソルが進んだとき（`conversation.read`）と、知らせを確かめたとき（`notification.acked`）は、
  つながっていない登録済みの端末に background push（`content-available`）を送る。中身はバッジの数、
  `readThroughPosition`、確認した notificationId である。
- アプリはこれを受けて、バッジを直す。さらに、届いている通知のうち、position がカーソル以下の返事と、
  確認済みの知らせを消す。
- background push は iOS が間引くので、確実には届かない。届かなかった分は、次にアプリを開いて同期したときに直す。
  アプリは前に戻ったとき、既読や確認の状態に合わせて、届いている通知とバッジを片づける。

### 6. 通知を押したら、メインの画面を開く

- 通知を押すとアプリが開き、いつもの規則で返事は吹き出しに、知らせは黄色いカードに出る。
- 通知から返事を書く操作や、確認のボタンは作らない。

### 7. サーバーは APNs に自分で送る

- `node:http2` で APNs に送る。依存は増やさない（ACME を自前で実装したのと同じ方針である）。
- 認証には token を使う。.p8 の鍵から ES256 の JWT を作り、50 分ごとに作り直す。
- config に `apns` を足す。中身は `teamId`、`keyId`、`topic`（アプリの bundle ID）、それに鍵の場所 `keyFile` か `keyEnv`
  （既存の SecretReference の形）である。`apns` がなければ通知は送らない。そのときも `push.register` は受け付けて記録する。
- 送れなかったときは、次のように扱う。
  - 5xx・429・接続の失敗は、メモリの中で間を空けて数回だけ送り直す。それでもだめなら log に残して諦める。
    サーバーが再起動すれば、送り直しの予定も消える。
  - `410 Unregistered` と `BadDeviceToken` は、その登録を消す。
  - 通知は、アプリを開かせる合図にすぎない。返事と知らせそのものは SQLite にあり、開けば同期で必ず読める。

### 8. 確かめ方

- サーバーは `node:test` で確かめる。対象は、JWT の生成、暗号化、送り先の選び方、送る payload、ローカルの HTTP/2 の偽の APNs への送信、
  送り直し、410 のときの登録の削除である。
- Node で作った暗号文を、`NatsumiCoreTests` の CryptoKit で復号する。そのための共通のテストベクタを置き、2 つの言語の間で暗号の手順がずれないようにする。
- 最後に、sandbox の APNs で実機に届くことを確かめる。

## Consequences

- 実機に入れるには、Push Notifications と Keychain Sharing の entitlement を付けた、有料のチームの署名が要る。
  ADR 0028 の「各自が自分のチームを選ぶ」は、通知を使うなら有料のチームに限られる。シミュレータは今までどおり動く。
- iPhone のアプリに、Notification Service Extension のターゲットが増える。
- Mac で読んでいても iPhone が鳴る。気になるようなら、`device.activity` を実装して絞る。
- 読んだ後の片づけは background push 頼みなので、アプリを開くまで、読んだはずの通知やバッジが残ることがある。
- 本文は Apple のサーバーを平文では通らない。ただし、通知があったこと、その時刻、返事か知らせかは Apple から見える。
- 送り直しはメモリの中だけなので、サーバーが落ちている間に出た返事の通知は届かないことがある。
- ADR 0028 の 4 の「裏にいる間の通知（APNs）は範囲外」は、この ADR で置き換える。
- ADR 0013 で未定のまま残していた「特定の端末だけで目立たせる」ことは、iPhone についてはこの ADR で決めた。
  配信先を 1 つに絞ることや lease、再配信は、引き続き作らない。
