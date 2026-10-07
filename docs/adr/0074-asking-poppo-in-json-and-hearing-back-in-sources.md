# 0074. ポッポさんへの依頼は JSON で書き、結果は /sources に置いて sources_updated で知らせる

- Date: 2026-10-07
- Status: Accepted

## Context

natsumi は Slack に投稿するツールを持たず、送信役のポッポさん（`poppo`）への `ask_agent` の依頼だけで投稿とリアクションをする
（[ADR 0039](0039-slack-as-files-and-a-scored-dove.md)・[ADR 0040](0040-the-dove-sends-what-the-judge-passes.md)）。

今の依頼の `message` は、見出し付きのテキストである。

- 見出しは `返信先`・`種類`・`表情`・`画像`（[ADR 0044](0044-drawing-with-sdctl-and-posting-images.md)）で、`---` の行の後が本文（リアクションなら絵文字）である。
- 返信先は `work/#dev 2026-09-25 14:32:05 山田` の形の文字列で、ワークスペース・チャンネル・秒までの時刻・発言者で発言を指す。
  サーバーは Slack の発言の記録と突き合わせる。同じ秒に同じ人の発言が複数あると決められず、natsumi は「」で書き出しを添えて指定し直す。
  チャンネルそのものへの投稿は `work/#dev` と書く。
- 一方、Slack の記録を読むときの natsumi は、ファイルのパスとファイルの中の場所（`jq -s` のパス）で発言を指している（[ADR 0050](0050-telling-of-source-updates-with-one-event.md)）。
  attention の `file` と `path` がそれである。返すときだけ、行の `at` と `from` から別の形の参照を組み立て直している。

結果は、受け付けたことだけを `ask_agent` の結果で返し、何が起きたか（`sent`・`reacted`・`to_owner`・`returned`・`rejected`・`expired`・`not_sent`）を
後から `agent_reply` の出来事（`agent: poppo`）で返している。

[ADR 0069](0069-agent-replies-as-files-in-sources.md) は、外から届くものを可能な限り `sources_updated` に寄せる方針を立て、
A2A の外のエージェントの返事を `/sources/agents/` のファイルと attention に移した。
ポッポさんの結果は「まだ決めていないこと」として残り、実装の前に本人が「今の `agent_reply` の出来事のまま残し、後で別の ADR で決める」とした。
そのため `agent_reply` の出来事の型は、ポッポさんのためだけに残っている。

本人は、ポッポさんへの依頼を JSON にし、結果を `sources_updated` で知らせることにした。
この ADR は、ADR 0069 の方針の 2 つ目の適用である。細部は本人との問答（Q1〜Q7）で決めた。

## Decision

### 依頼は `ask_agent`（agent: poppo）の `message` に JSON を 1 つ書く

- `message` は JSON のオブジェクト 1 つとする。ツールは増やさず、`ask_agent` の引数の形も変えない。
- 欄は次のとおりである。

| 欄 | 中身 |
| --- | --- |
| `kind` | `post`（投稿）か `reaction`（リアクション） |
| `to` | 返す先。`{file, path}`（次の節） |
| `face` | 省略できる。Slack に出すアイコンの表情（[ADR 0026](0026-a-feeling-on-each-line.md) の一覧） |
| `text` | 投稿の本文 |
| `emoji` | リアクションの絵文字の名前 |
| `images` | 省略できる。投稿に付ける画像のパスの並び（ADR 0044 の規則のまま） |

- どの `kind` でどの欄が要るか（`post` の `text` と `images`、`reaction` の `emoji`）、知らない欄の扱いは、サーバーの検査で決める。検査の細部は実装の PR で決める。
- 判定・承認・送る・リアクションを付ける流れ（ADR 0040・[ADR 0042](0042-any-emoji-that-exists.md)・ADR 0044・[ADR 0059](0059-two-judges-side-by-side-and-fewer-issues.md)・[ADR 0062](0062-three-placements-for-a-reply.md)）は変えない。
  変わるのは、依頼の書き方と結果の届き方だけである。

### 返す先 `to` は、ファイルとファイルの中の場所で書く

- `to` は `{file, path}` とし、Slack の記録を読むときと同じ形で返す先を指す。
  - `file` がチャンネルのディレクトリ（例: `/sources/slack/work/dev`）なら、そのチャンネルに直接投稿する。`path` は書かない。
  - `file` が `.jsonl` で `path`（`jq -s` のパス）があれば、その発言に返す。
  - `file` が `.jsonl` で `path` が無ければ、その場で断る。
- natsumi は attention の `file` と `path`、またはファイルの行の番号をそのまま写せる。参照を組み立て直さない。
  行の番号は発言ごとに一意なので、同じ秒の発言を書き出しで見分ける手順は要らなくなる。
- `path` は、natsumi が読むファイルの中の場所であり、Slack の ts のような ID ではない。[ADR 0024](0024-no-event-ids-for-the-model.md) には当たらない（ADR 0069 の依頼のディレクトリの場所と同じ考え方）。
- 人が読める手がかりは、サーバーが依頼の記録（`request.json`、後述）に発言の抜粋を書き足して補う。抜粋の形は実装の PR で決める。
- 退けた案:
  - `{channel}` の欄を別に作る。チャンネルもディレクトリで指せば、欄が 1 つで済む。
  - 今の参照の文字列（`work/#dev 2026-09-25 14:32:05 山田`）を欄に入れる。読むときの形と返すときの形が分かれたままになり、同じ秒の発言も見分けられない。
  - `{file, path}` と参照の文字列の両方を持つ。書き方が 2 つになる。

### `face` は省略でき、省けば neutral

- 今のとおり、表情は省略でき、省けば neutral とする。
- 必須にする案は退けた。必須にしようとした理由は「なつみが表情を変えていない気がする」だったが、本人が確かめたところ表情は変わっていた。

### 見出し付きのテキストは、すぐ受け付けなくする

- この版から、JSON として読めない依頼は頼まずにその場で断る。断りの文で `/manual/slack.md` の形で頼み直すように返す。
- 退けた案: しばらく両方を受け付ける。natsumi が読む依頼の形は manual の 1 つだけであり、2 つの形を検査し続ける理由が無い。

### 依頼の形は manual の表と例で示し、検査の断りの文で具体的に返す

- `/manual/slack.md` に、欄の表と例だけを載せる。
- サーバーは依頼の形を検査し、合わなければ、どの欄がどう違うかを断りの文で具体的に返す。
- 退けた案:
  - JSON Schema を manual に載せる。natsumi が読む量が増え、表と例で足りる。
  - JSON Schema をコードに持ち、それで検査する。断りの文を欄ごとに具体的にしたいので、検査は手で書く。

### 結果は `/sources/agents/poppo/` の依頼のディレクトリに置く

- サーバーは依頼ごとにディレクトリを作り、`/sources/agents/poppo/<日時>-<印>/` に置く。日時と印の作り方は ADR 0069 と同じである。
- ディレクトリには次のファイルを置く。

| ファイル | 中身 |
| --- | --- |
| `request.json` | 受け付けた依頼。サーバーが返す先の発言の抜粋を書き足す |
| `results.jsonl` | 結果。結果ごとに 1 行を足す |

- `sent` の結果では、attention の `file`・`path` で、Slack の記録の中の natsumi 自身の投稿の行を指す。
- ディレクトリの中の構成の細部（`README.md` を置くか、`sources-diff` の履歴に入れるファイル、ADR 0069 の `request.md`・`README.md` との揃え方）は実装の PR で決める。
- 退けた案:
  - Slack の記録（チャンネルのファイル）に attention を付けるだけにする。突き返し・本人に回した・見送ったなど、Slack に何も出ない結果の置き場所が無い。
  - 依頼のディレクトリと Slack の記録の attention を併用する。知らせが 2 か所から来る。

### 結果のたびに attention で知らせる

- `results.jsonl` に 1 行足すたびに、`agents` の更新元として attention を出す。届き方は今の `agent_reply` の出来事と同じく、結果ごとにすぐ届く。
  - 例: `to_owner`（本人に回した）の後に、本人の承認で `sent` が続く。
- attention の種類は `agent_reply`、相手は `poppo` で、`state` はそのときの最新の結果とする。ほかの欄の名前（`summary`、`sent` のときの Slack の `file`・`path` など）は実装の PR で決める。
- ADR 0069 の「1 つのディレクトリの中で state は変わらない」は、ポッポさんには当てはまらない。
  ポッポさんの依頼では、1 つの依頼に結果が何度も付き、同じディレクトリの中で state が変わる。これは ADR 0069 の例外である。
- 退けた案: 決着（`sent`・`reacted`・`rejected`・`expired`・`not_sent` など）だけを知らせる。`to_owner` や `returned` を知らないと、なつみは待つのか直すのかを決められない。

### `agent_reply` の出来事の型をなくす

- ポッポさんの結果が attention に移れば、`agent_reply` の出来事を使うものは無くなる。型ごと消し、system prompt とツールの説明からも消す。
- 移行は次のとおりにする。
  - 版を上げた時点でまだなつみに渡していない `agent_reply` の出来事は、前の形のまま 1 度だけ渡す。
  - 版を上げた時点で `to_owner`（本人の決定待ち）の依頼は、依頼のディレクトリを持たない。結果が出たときにディレクトリを作り、`request.json` は承認の記録の下書きなどから組み立てる。
  - 型を消すのは、この移行を済ませた後とする。
- 退けた案: 型を残す。使うものが無いのに system prompt に説明が残り、出来事の種類が減らない。

### 置き換える既存の決定

- ADR 0039
  - 置き換え:「ポッポさんへの依頼」の、`message` を見出し付きのテキストにする点と、返信先を `work/#dev 2026-09-25 14:32:05 山田` の参照で書く点。JSON の `to` の `{file, path}` で書く。Slack の ts を写させない点は残す。
  - 置き換え:「返事のアイコン」の、表情を `表情` の見出しで渡す点。`face` の欄で渡す。
  - 置き換え:「リアクション」の、`種類` と本文で頼む点。`kind: reaction` と `emoji` で頼む。
- ADR 0040
  - 置き換え:「ポッポさんはサーバーの中にいる」の、結果を `agent_reply` の出来事で返す点。依頼のディレクトリの `results.jsonl` に置き、`sources_updated` の attention で知らせる。台詞をサーバーが整える点と、Slack の ts と承認の ID を載せない点は残す。
  - 置き換え:「依頼の形と、返信先の突き合わせ」の、見出し付きのテキストの検査と、時刻と発言者による突き合わせ（同じ秒の発言を書き出しで見分ける点を含む）。JSON の欄の検査と、`{file, path}` による指定になる。本文の機械的な検査は残す。
- ADR 0044
  - 置き換え: 依頼の見出し `画像: <パス>`。`images` の欄で渡す。画像の検査と写しの規則は残す。
- ADR 0069
  - 置き換え:「まだ決めていないこと」の、ポッポさんの結果を `agent_reply` の出来事のまま残す点と、`agent_reply` の出来事の型を残す点。
  - 例外の追加:「1 つのディレクトリの中で state は変わらない」は、ポッポさんの依頼のディレクトリには当てはまらない。
- ADR 0050
  - 追加: 更新元 `agents` に、ポッポさんの依頼のディレクトリが加わる。

### 実装の PR で決めること

- 依頼のディレクトリのファイル構成の細部（`README.md` を置くか、`sources-diff` の履歴に入れるファイル）と、ADR 0069 の `request.md`・`README.md` との揃え方。
- `request.json` にサーバーが書き足す、返す先の発言の抜粋の形。
- attention の欄（`agent`・`state`・`summary`、`sent` のときの Slack の `file`・`path`）の名前。
- `kind` ごとの必須の欄、知らない欄の扱いなど、検査の細部。
- 断りの文の言い回し、`ask_agent` の結果の文とツールの説明（固定の文、[ADR 0019](0019-a-workspace-not-a-memory-tool.md)）、`/manual/slack.md` と `/manual/ask-agent.md` の書き換え。

## Consequences

- なつみは、Slack の記録を読むときと同じ `{file, path}` で返す先を指せる。参照の組み立て直しと、同じ秒の発言の指定し直しが無くなる。
- 依頼の形が変わるので、版を上げた後は見出し付きのテキストの依頼が断られる。なつみは manual と断りの文で新しい形に移る。
- ポッポさんの結果も `/sources/agents/poppo/` に残り、前に何を頼み、どうなったかを `ls` や `grep -r` で後から探せる。data directory は依頼の分だけ増える。
- 出来事の種類から `agent_reply` が無くなる。system prompt の出来事の説明、`ask_agent` のツールの説明、manual が変わり、反映した時点で prefix が変わる。
- 1 つのディレクトリの中で state が変わるのはポッポさんだけになる。ADR 0069 の外のエージェントの返事とは、ディレクトリの読み方が少し違う。
- 結果は今と同じく、結果ごとにすぐ届く。awake hours の外でも出る（ADR 0050）。
