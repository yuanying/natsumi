# natsumi のアバター

Mac アプリが既定で使うアバターのアセットです。

| ファイル | 内容 |
| --- | --- |
| `spritesheet.webp` | 動作ごとのフレームを並べた spritesheet（1 マス 192×208、8 列 × 11 行、背景は透明） |
| `pet.json` | Codex のペットの形式の定義 |
| `avatar.json` | atlas（行ごとの動作とフレーム数）、サーバーの表情から動作への対応表、表情ごとの顔のアイコンの場所（`icons`） |
| `icons/<表情>.webp` | 会話の履歴でセリフの横に出す、表情ごとの顔（512×512）。8 つの表情にそれぞれ 1 枚 |
| `icons/angry.webp` | 怒った顔（512×512）。サーバーの表情にまだ `angry` がないので、`avatar.json` の `icons` には載せていない |

## ライセンス

このディレクトリのアセット（`spritesheet.webp`・`pet.json`・`avatar.json`）は
[Creative Commons Attribution 4.0 International（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/)
で提供します。リポジトリのコードのライセンス（MIT）とは別です。

## 出どころ

- キャラクターの参照画像は Anima で生成しました。
- spritesheet は、その参照画像をもとに OpenAI の画像生成で作りました。
