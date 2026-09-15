# 0010. Mac アプリの構成

- Date: 2026-09-15
- Status: Accepted

## Context

サーバーは GitHub ログイン（ADR 0006）、単一の思考ループと Mac との会話（ADR 0008）、夜の切り替え（ADR 0009）を提供している。
Mac の側には、まだ何もない。合意しているのは、Swift/SwiftUI と AppKit で作り、デスクトップにキャラクターが常駐して、
クリックで会話欄を開くことだけである。

最初の Mac アプリを作るにあたり、次を決める必要がある。

- Xcode プロジェクトの形、対応する macOS、署名。Apple Developer のチームがなくても、手元で build とテストができること
- [client-contract.md](../client-contract.md) の同期（端末の登録、stream と seq、差分の再送と snapshot）、送信の requestId、再接続を、
  実際のサーバーやネットワークなしにテストで確かめる方法
- セッションのトークンを Keychain 以外に書かないことを、どう保証するか
- キャラクターの絵。合意した時点ではアートが未決定だったが、その後、Codex のペットの形式で作ったナツミのアセットを使うことになった

## Decision

### プロジェクト

- `mac/Natsumi.xcodeproj` に、次の 3 つのターゲットと、共有の scheme `Natsumi` を置く。
  - `Natsumi`: アプリ。AppKit と SwiftUI の UI、WebSocket の接続、`ASWebAuthenticationSession` など、OS に依存する部分だけを持つ。
  - `NatsumiCore`: framework。envelope の読み書き、同期と再接続の判断、会話の表示の状態、ログインの PKCE と callback の検証、
    保存の境界、アバターの読み込みを持つ。AppKit と UI に依存しない。
  - `NatsumiCoreTests`: `NatsumiCore` のテスト（Swift Testing）。ホストのアプリを起動せず、ネットワークにも接続しない。
- プロジェクトは生成ツールを使わず、Xcode のフォルダーの同期（synchronized folders）で手で保つ。
  ソースを足してもプロジェクトのファイルは変わらない。生成ツールを入れる手間と、その版の管理を増やさないためである。
- 対応するのは macOS 15 以降、Swift 6 の言語モードとする。
- 署名は ad-hoc（`-`）とし、チームも証明書も指定しない。App Sandbox と Hardened Runtime は使わない。
  公証と配布は、この ADR の範囲外として後で決める。
- build と test のコマンドは README に書く。build 結果は `mac/build/` に置き、Git で追跡しない。

### 接続と同期

- 接続は、I/O を持たない状態機械（`SessionMachine`）で表す。入力は「接続した」「受信した」「切れた（close code か HTTP の状態）」「送信」
  「再接続のタイマー」で、出力は「接続する」「送る」「端末 ID を保存する」「ログインを求める」「再接続を予約する」などの指示である。
  アプリがその指示を実行する。これで同期と再接続の規則を、サーバーなしでテストできる。
- イベントは、最後の snapshot か resume で決まった stream の、次の seq のときだけ適用する。
  - すでに受け取った seq は無視する。
  - seq の欠け、epoch や stream の変化では、`resume` なしの `session.sync` を送り、snapshot を待つ。同期は一度に 1 つだけ送る。
  - 未知の `type` は適用しないが、その seq は受け取ったものとして進める。未知の表情の値も無視する。
  - 同期の前の応答（接続ごとの一時的な stream の `command.rejected` など）は適用するが、位置にはしない。
- 最後に受け取った位置はメモリにだけ置き、再接続の `resume` に使う。端末 ID は設定（UserDefaults）に保存する。
  アプリを再起動したら、サーバーの snapshot から始める（client-contract のとおり、独自の会話 DB は持たない）。
- 送信には UUID の requestId を付け、`command.accepted` が届くまで送信欄の外（outbox）に「受付中」として残す。
  同期の前や切断中の送信は、同期が済んだら同じ requestId で送る（サーバーが同じ結果を返す）。拒否されたものはエラーとして表示し、再送しない。
- 再接続は 1 秒から倍にして、30 秒で頭打ちにする。同期できたら 1 秒に戻す。
  - close code 1008 と、upgrade の 401 は、セッションの終わりとしてトークンを消し、ログインを求める。再接続しない。
  - 4001（同じ端末の新しい接続への置き換え）では再接続しない。1002・1007（プロトコルの誤り）では止まる。
  - それ以外（4002 を含む）は再接続する。
- `service.unavailable` が同期の応答なら、会話を使えない状態として表示し、利用者の操作で接続し直す。

### ログインと保存

- `ASWebAuthenticationSession` を callback の scheme `natsumi` で使う（ADR 0006）。scheme はセッションが受け取るので、
  アプリの Info.plist には URL scheme を登録しない。登録すると、ログインの外から来た `natsumi://` でもアプリが開くようになるためである。
- PKCE の verifier とアプリの state は、それぞれ 256 ビットの乱数を base64url にした 43 文字とする。
  callback では、state の一致を最初に確かめ、一致しなければ `code` も `error` も使わない。
- トークンは login keychain の generic password にだけ保存する。保存の境界は `SecretStore` の口で分け、
  テストで、ログインした後の設定（UserDefaults）に書かれたキーが接続先の origin と端末 ID だけで、トークンを含まないことを確かめる。
- 接続先の URL は設定画面で入れる。https の origin だけを受け付け、http は loopback のホストに限る。
  接続先を変えたら、前のサーバーのトークンと端末 ID を捨てる。
- 期限を過ぎたトークンは、使う前に消してログインを求める。ログアウトは `POST /auth/logout` を試みてから、トークンを消す。

### UI

- アプリはメニューバーに常駐し、Dock には出さない（`LSUIElement`）。メニューには状態、会話を開く、ログイン、設定、ログアウト、終了を置く。
- キャラクターは、枠のない、フォーカスを奪わないパネルで、ほかのウインドウの上に浮かび、すべての Space に出る。
  ドラッグで動かし、位置を覚える。クリックで会話欄を開閉する。接続していないときは、小さな印を付ける。
- 会話欄は、snapshot と `conversation.message` の履歴、送信欄、「受付中」（受付の前の送信）、「考え中」（表情が thinking か、処理待ちのイベントがある）、
  返事と知らせの区別（知らせには「お知らせ」と印を付ける）、送れなかった送信のエラーを表示する。

### アバター

- 形式は Codex のペット（`pet.json` と spritesheet の atlas）とし、任意の `avatar.json` で atlas・動作・再生の速さ・表情と動作の対応表を足す。
  `avatar.json` がなければ、Codex のペットの既定の配置と、既定の対応表を使う。
- 対応表にない表情は neutral の動作で表示する。範囲外の行、atlas より小さい画像、対応表が指す存在しない動作、ディレクトリの外を指す spritesheet は、読み込みの誤りとする。
- 読み込む順は、利用者のディレクトリ（既定 `~/Library/Application Support/natsumi/avatar/`、設定で変更可）、同梱のアセット、仮の絵（表情ごとの絵文字）である。
  表情を足すときに、手元で試してからリポジトリに入れられるようにするためである。
- 同梱のアセットは `mac/Avatars/natsumi/` に置き、アプリの resources にフォルダーのまま入れる。
  サーバーの 8 つの表情のうち、当面は sleepy に専用の動作がなく、idle で表示する。
- ライセンスは、コードを MIT、`mac/Avatars/` のアセットを CC BY 4.0 とする。

## Consequences

- ad-hoc 署名はビルドのたびに変わるので、ビルドし直したアプリが Keychain の項目を読むときに、確認のダイアログが出ることがある。
  チームの署名にすれば解消するが、配布を決めるときに合わせて扱う。
- App Sandbox を使っていない。配布の形を決めるときに、ネットワーク・Keychain・利用者のアバターのディレクトリの権限と合わせて見直す。
- Keychain を使うテストは、ログイン中のユーザーの GUI のセッションで実行する必要がある。SSH のセッションでは失敗する。
- UI（パネル、会話欄、ログインのシート）と、`URLSessionWebSocketTask` を使う接続の部分には自動テストがない。実際のサーバーでの手動の確認に頼る。
- `URLSessionWebSocketTask` は、定義済みでない close code（4001・4002）を区別して渡さないので、これらはネットワークの切断として扱い、再接続する。
  4001 を受けても再接続するが、置き換えたのは同じ端末の新しい接続なので、1 つのアプリの中では接続が往復し続けることはない。
- `service.unavailable` の後、サーバーの会話が使えるようになったことを知らせるイベントは契約にない。利用者が「接続し直す」を押す必要がある。
- サーバーからのメッセージの大きさの上限は契約にない。snapshot は最大 500 件のメッセージを含み得るので、受信の上限を 16 MiB にした。
- 承認・通知・Slack・音声、最終的な表情のアート（sleepy など）、配布は、この ADR の範囲外である。
