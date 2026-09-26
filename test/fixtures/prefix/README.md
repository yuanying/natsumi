# prefix のスナップショット

`with-workspace.json` と `without-workspace.json` は、session の生成時に 1 度だけ組まれ、session の間ずっと
変わらないもの —— system prompt とツールの定義 —— をそのまま写したものである。`test/prefix.test.ts` が突き合わせる。

**変えるときは意図して更新する。prefix が変わると、走っている session のキャッシュが全損する。**
バックエンドは prefill が遅く、ここが 1 文字変わると、その session は夜の切り替えで作り直されるまで、
毎ターン prompt 全体を読み直すことになる（ADR 0019）。

更新するときは、文面を変えた上で次を実行し、差分を読んでからコミットする。

```
UPDATE_PREFIX_FIXTURES=1 node --test test/prefix.test.ts
```

## 中身

- `systemPrompt` —— サーバーが組む指示。`personality.md`・`always.md`・`handoff.md` には固定の 1 行ずつを
  入れて測っている。写っているのは骨組みと、サーバーが各節に付ける見出しであり、記憶の中身ではない。
  3 つのファイルはどれも自分の見出しで始めてあるので、**サーバーの見出しと重なっていないこと**もここで固定される
  （ADR 0020）。
- `trailer` —— Pi が後ろに足す作業ディレクトリの節（`<cwd>`）。`{dataDirectory}` は実行ごとに変わるデータディレクトリを置き換えたもの。
  Pi の更新でここが増えれば、文面を変えていなくても prefix は動く。
- `tools` —— `createLoopTools` が返す順のツール。`name`・`description`・`parameters`（JSON schema）。
