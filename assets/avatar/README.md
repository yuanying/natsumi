# Slack に出す natsumi の顔

ポッポさんが Slack に投稿するときのアイコンです（ADR 0040）。
サーバーが `/avatar/<表情>.png` で認証なしに配り、`chat.postMessage` の `icon_url` に渡します。

- 元は `mac/Avatars/natsumi/icons/<表情>.webp`（512×512）です。256×256 の PNG に縮めて変換しました。
- 表情は、なつみがセリフに付けられる 8 つ（neutral・happy・laughing・surprised・thinking・worried・sad・sleepy）です。
- 元の画像を差し替えたら、ここも作り直します。Node は WebP を読めないので、変換は手で行います
  （例: Python の Pillow で開き、RGB にして 256×256 に縮め、PNG で保存する）。

## ライセンス

元のアセットと同じく [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) です。
リポジトリのコードのライセンス（MIT）とは別です。出どころは `mac/Avatars/natsumi/README.md` にあります。
