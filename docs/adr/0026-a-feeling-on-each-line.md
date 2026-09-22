# 0026. セリフごとに気持ちを載せる

- Date: 2026-09-22
- Status: Accepted

## Context

natsumi の表情は `set_mac_avatar_expression` で付ける（[ADR 0008](0008-single-thinking-loop-and-mac-conversation.md)）。
候補は neutral・happy・laughing・surprised・thinking・worried・sad・sleepy の 8 つで、表情はメモリだけに持ち、
しばらくすると neutral に戻る（[ADR 0014](0014-self-checks-and-pings.md)）。

表情は「いまのキャラクター」の状態であり、セリフとは結びついていない。会話ウインドウの履歴
（[ADR 0021](0021-the-input-and-the-history-in-one-window.md)）を後から読むと、どのセリフをどんな気持ちで言ったかは残っていない。
利用者は、表情とは別にセリフにも感情を載せ、最終的には履歴のセリフごとに表情のアイコンを付けたいと考えている。

考えた案は次の 2 つである。

- **A. セリフを送るツールに引数を足し、natsumi がセリフごとに選ぶ。**
- **B. セリフを送った時点の表情を、サーバーが記録する。** ツールは変わらないが、セリフの気持ちが表情の変更と結びつく。
  表情を変えずに言ったセリフは、直前の表情か neutral になる。

また、ツールの定義と system prompt は session の生成時に 1 度だけ組まれ、prefix cache に乗る。
バックエンドは prefill が遅いので、ツールの説明を設定や実行環境から組み立てない（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)）。

## Decision

### 1. セリフを送るツールに、必須の `expression` を足す

`reply_to_mac` と `notify_owner` に `expression` の引数を足す。natsumi はセリフごとに、そのセリフに込める気持ちを選ぶ（案 A）。

- **候補は表情と同じ 8 つ**で、`set_mac_avatar_expression` と同じ一覧を共有する。表情を足すと、セリフの候補も一緒に増える。
  契約の値もアイコンの絵も表情と共有できる。
- **必須とする。** 付け忘れと候補外の値は、今の引数の誤りと同じく Pi がツールの呼び出しの時点で弾く。
  セリフは送られず、誤りの文が natsumi に返る。
- ツールの説明は**固定の文**のままにする。候補は引数の定義（enum）にあり、説明には並べない。
  説明には、気持ちはセリフと一緒に履歴に残ること、アバターの表情は変わらないこと、表情を変えるのは
  `set_mac_avatar_expression` であることを書く。system prompt の「動き方」にも同じ趣旨を 1 行足す。

### 2. セリフの気持ちでキャラクターの表情は変えない

セリフの `expression` は、アバターの表情と**完全に別**である。セリフを送っても `avatar.expression` は送らず、
表情を neutral に戻すまでの時間にも触らない。キャラクターの表情は今までどおり `set_mac_avatar_expression` と時間で動く。

### 3. 気持ちはセリフと一緒に SQLite に残す

Mac に見せる会話の表に `expression` の列を足す（schema 9）。

- 値を持つのは natsumi のセリフ（kind: reply・notice）だけである。本人のメッセージには付けない。表の CHECK でもそう縛る。
- **この変更より前のセリフは NULL のままにする。** neutral で埋め戻さない。NULL は「分からない」であり、「平静」ではない。
- 候補の一覧は表の CHECK に書かない。候補はツールとサーバーが守る。CHECK に書くと、表情を足すたびに表の作り直しが要る。

### 4. 契約では、セリフに `expression` の欄を載せる

`conversation.message` と `session.snapshot` の `messages` の natsumi のセリフに `expression` を載せる。
値が無いもの（本人のメッセージと、schema 9 より前のセリフ）は、**null ではなく欄を省く**。
`eventId`・`replyTo`・`about` と同じく、無いものは載せない形に揃える。クライアントは、欄が無いことを「不明」と読む。

### 範囲の外

- Mac の履歴の表情アイコン。クライアントの実装は別の作業として行う。絵の選び方もそこで決める。
- 表情の候補を増やすこと。気分（長く続く状態）。

## Consequences

- 履歴を読み返したとき、natsumi のセリフごとに気持ちが分かる。表情を変えずに言ったセリフにも気持ちが残る。
- ツールの定義と system prompt が変わるので、反映した時点の session は prefix cache を 1 度失う。
  走っている session のツール定義は差し替わらないため、反映はサーバーの再起動（新しい session）で行う。
- natsumi は返事と知らせのたびに 1 つ多く選ぶことになる。付け忘れは誤りとして返るので、その分だけ呼び直しが起きうる。
- 表情とセリフの気持ちが別なので、「happy のセリフを言いながら表情は worried」という組み合わせも起こる。
  どちらを使うかは natsumi が選ぶ。
- 表情を足すときは、セリフの候補と Mac のアイコンも一緒に増える。Mac は知らない値を受け取りうるので、
  知らない値は不明と同じに扱う必要がある。
- Mac は未知の欄を無視してデコードするので、Mac を更新しなくてもサーバーを先に反映できる。
