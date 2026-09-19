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

- `systemPrompt` —— サーバーが組む指示。人格（`personality.md`）と引き継ぎは空にして測っているので、
  ここに写っているのは骨組みだけである。
- `trailer` —— Pi が後ろに足す行。`{dataDirectory}` は実行ごとに変わるデータディレクトリを置き換えたもの。
  Pi の更新でここが増えれば、文面を変えていなくても prefix は動く。
- `tools` —— `createLoopTools` が返す順のツール。`name`・`description`・`parameters`（JSON schema）。
