# 画像を作る（sdctl）

run_shell で `sdctl` を使うと、本人の画像生成サーバー（Stable Diffusion WebUI）で画像を作れます。
作った画像は `view` で見て、Slack に出すならポッポさんに頼みます。

## いちばん短い手順

既定の設定（`/etc/sdctl/anima.yaml`）を使えば、書くのはプロンプトだけです。

**1. プロンプトを `/work/images/` の下にファイルで書きます。**

```
mkdir -p /work/images
cat > /work/images/cat.yaml <<'EOF'
prompt: |
  masterpiece, best quality, newest, safe,
  no humans,
  A white cat is sleeping on a sunny windowsill.
  cat, white fur, sleeping, curled up,
  windowsill, sunlight, indoors
EOF
```

**2. 作ります。** 1 枚に 30 秒ほどかかります。

```
sdctl txt2img --params /etc/sdctl/anima.yaml --prompt /work/images/cat.yaml -o /work/images/cat.png > /dev/null
```

- 進み具合の表示は長いので、`> /dev/null` で捨てます。失敗したときのエラーは、それでも表示されます。
- 出力（`-o`）は必ず `/work/` の下にします。ほかの場所の画像は、Slack に出せません。
- 同じ名前で作ると上書きします。作り直すときは、名前を変えると見比べられます。

**3. 見て確かめます。**

```
view /work/images/cat.png
```

**4. Slack に出すなら**、ポッポさんへの依頼に `画像: /work/images/cat.png` の見出しを足します（`/manual/slack.md`）。

## 既定の設定

| 項目 | 値 |
| --- | --- |
| モデル | `anima_mignolia_v10`（Anima 系） |
| 大きさ | 896×1152（縦長） |
| steps・CFG | 30・4.5 |
| sampler・scheduler | `ER SDE`・`simple` |

- 大きさを変えるときは `--width` と `--height` を足します（例: 横長 `--width 1152 --height 896`、正方形 `--width 1024 --height 1024`）。
  幅も高さも 16 の倍数で、面積は 896×1152 くらいに保ちます。
- 本人の GPU はほかの用途と共有です。何十枚も作り続けず、数回で決めます。

## プロンプトの書き方（Anima）

英語で、上から次の順に書きます。使わない行は行ごと省きます。

```
masterpiece, best quality, newest, safe,      ← 品質・新しさ・安全
1girl,                                        ← 人数（人がいなければ no humans）
A girl is reading a book in a quiet library.  ← 全体の場面を 1 文で
    a calm girl with long black hair ...      ← 人物を 1 文で（外見・服・動作）
    1girl, long hair, black hair, reading,    ← 同じ内容をタグで
upper body, from side,                        ← 構図
indoors, library, warm lighting               ← 背景と光
```

- タグは小文字で、単語はスペースで区切ります（`long_hair` ではなく `long hair`）。
- Slack に出すものには `safe` を付けます。
- 人数タグ（`1girl`・`2girls`・`no humans`）を品質タグの次に必ず書きます。2 人以上なら、人ごとに `On the left,` のような位置の言葉で分けて書きます。
- 文の中で `she`・`it` を使わず、`the girl`・`the cup` のように名詞で書きます。
- 強めたい語は `(smile:1.5)` のように 1.5〜2 の重みを付けます。
- 写真のような写実は出ません。文字は短い単語までです。
- 手が崩れたら、`both hands clearly visible` のように手の様子をはっきり書きます。

## あなた自身の姿

あなた（なつみ）を描くときは、プロンプトの先頭にこれをそのまま置きます（1 行目は、あなたの姿を覚えさせた LoRA `kutara_aki_anima.v3` です）。

```
<lora:kutara_aki_anima.v3:1> ,
masterpiece, newest,
woman, low ponytail, freckles,

black glasses,
black business suit,  collared white shirt, large breasts,
```

その後に、人数・場面・表情・構図・背景を続けます。

```
cat > /work/images/me.yaml <<'EOF'
prompt: |
  <lora:kutara_aki_anima.v3:1> ,
  masterpiece, newest,
  woman, low ponytail, freckles,

  black glasses,
  black business suit,  collared white shirt, large breasts,
  1girl, solo, upper body, smile, looking at viewer,
  indoors, office, window, soft daylight
EOF
sdctl txt2img --params /etc/sdctl/anima.yaml --prompt /work/images/me.yaml -o /work/images/me.png > /dev/null
```
