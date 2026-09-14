# Pi SDK 検証

2026-09-14、Linux 上で次のバージョンを使用した。

| 対象 | バージョン |
| --- | --- |
| `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` | 0.85.1（npm の latest） |
| `typebox` | 1.3.7 |
| Node.js / npm | 24.12.0 / 11.6.2 |
| TypeScript / `@types/node` | 5.9.3 / 24.10.1 |

旧 `@mariozechner/pi-coding-agent` は npm 上で deprecated と表示され、`@earendil-works` への移行が案内されている。
この検証は現行 package の同梱文書（`docs/sdk.md`、`docs/models.md`、`docs/custom-provider.md`）と型定義を基準にした。
ハーネスは Pi のバージョンが 0.85.1 でない場合に実行を拒否する。

## 再実行

通常検証は外部認証・ネットワークなしで動く。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

実接続は次のどちらか一方を明示したときだけ行う。両方の指定、どちらもない指定、コマンドライン上の API key は拒否する。
下記の URL・パス・モデル ID は架空の例である。

```sh
# ChatGPT subscription (Pi の openai-codex provider)。専用 Pi 領域で /login 済みの auth.json を参照する
npm run probe:live -- --auth-path /srv/natsumi-pi/agent/auth.json

# 本人が管理する OpenAI 互換エンドポイント（llama.cpp など）。key は環境変数からだけ渡す
NATSUMI_PI_API_KEY=... npm run probe:live -- \
  --compatible-base-url https://llm.example.invalid/v1 --compatible-model example-model
```

ハーネスは OS 一時ディレクトリに `natsumi-pi-probe-*` を作り、mode 0700 の workspace・agentDir・session 保存先を使う。
子プロセスには PATH、一時 HOME、`PI_CODING_AGENT_DIR`、`PI_OFFLINE=1`、LANG と、互換エンドポイント用の
`NATSUMI_PI_API_KEY`（設定時のみ）だけを渡す。他の provider の API key は継承しない。
Pi の拡張・skills・prompt template・context file の自動探索、compaction、自動 retry を無効にする。
有効なツールは架空の `calendar_propose` だけで、固定の `pending-approval` を返す。

subscription 経路は `auth.json` を直接参照し、コピーしない。Pi による通常の OAuth refresh はこのファイルを更新し得る。
OAuth credential がなければモデル送信前に停止し、API key・別 provider へ fallback しない。
互換経路は `ModelRuntime.registerProvider` で Chat Completions の provider を一つ登録し、
key は `$NATSUMI_PI_API_KEY` の参照として Pi が要求時に解決する。平文 HTTP はループバックだけ許可する。
Qwen 系の chat template 向けに `chat_template_kwargs.enable_thinking: false` を送り、非思考で応答させる。

1 回の実行で次を確認し、一時ディレクトリを削除する。

1. 子プロセス A: session を作成し、架空の合言葉を覚えさせる。user entry と assistant 応答（stop）が永続化されること
2. 子プロセス A を終了し、子プロセス B で同じ session ファイルを開く。header・全行の JSON・session ID が一致すること
3. B で合言葉を含まない質問を送り、応答が保存済み文脈の合言葉を含むこと。entry ID の列が A の続きであること
4. 別 session で `calendar_propose` の呼び出しを依頼し、実行されたツール結果を分類する。
   未登録ツールの成功は失敗、提案ツールの結果は `pending-approval` だけを許す

出力は固定の判定値だけで、key、URL、パス、session ID、会話本文、上流のエラー本文を含めない。
文脈継続と提案ツールが確認できれば exit 0、ツールが呼ばれなかった・検証失敗は exit 1、
経路・認証・key の指定不足は exit 2。

## 実測結果

| 経路 | 項目 | 結果 |
| --- | --- | --- |
| 互換エンドポイント（本人管理の llama.cpp、Qwen 系モデル、非思考） | 作成・送信・履歴・プロセス再起動後の resume・文脈継続 | 成功 |
| 同上 | 提案ツールの実行 | `proposal-pending-approval`。exit 0 |
| ChatGPT subscription（Plus） | 専用領域の OAuth credential 検出と session 作成 | 成功 |
| 同上 | 当時の固定モデル `gpt-5.4` への送信 | 上流が unsupported model として拒否。応答なし |
| 同上 | 固定モデルを Pi 0.85.1 の `openai-codex` 既定である `gpt-5.5` に変更後の再実行 | 利用上限に達したため未実施 |
| 音声 | — | 無効。未検証 |

subscription 経路で使えるモデルは、アカウントや時期で変わり得る。
`gpt-5.5` での成功はまだ確認していない。
Plus と互換エンドポイントの結果を混ぜず、互換経路の成功を Plus 経路の動作確認とは扱わない。

## 自動テスト

fixture は Pi SDK の実オブジェクトを使い、モデル stream だけを合成する。次を確認する。

- session の作成・永続化・同じ session ID での復元と文脈継続
- 存在しない・header が壊れた・header は正しく本文行が壊れた session の復元拒否（新しい session を作らない）
- provider エラーを成功 turn と扱わないこと、上流エラー本文を例外に出さないこと
- 期限による中断、同時送信の拒否
- 有効ツールが `calendar_propose` だけであること、未登録の書き込みツールを実行できないこと
- 未登録モデルを別モデルで代替しないこと
- 再開時に合言葉を思い出せない応答を失敗とすること、ツール検証の分類
- 別プロセスでの作成と再開、子プロセスの異常終了・停止の検出、子プロセスへの環境変数の限定
- OAuth がない・API key の credential しかない場合の subscription 経路の拒否
- 互換経路の key 必須・key 値を設定に保持しないこと・平文 HTTP の拒否
- 実接続の経路指定の排他と必須項目

## 未検証

コンテナの build/再作成、Mac の build と録音・再生、音声、本体の複数クライアント同期、GitHub 認証、通知、
Calendar 承認と実行、Google/Wiki 連携、OS 権限・ネットワーク制限による隔離は未実装・未検証。
compaction・自動 retry を有効にした場合の同期と復旧も未検証。
それぞれ [後続 PR の順序](client-contract.md#後続-pr-と検証順) で実装と試験を行う。
