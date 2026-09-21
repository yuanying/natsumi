# Mac アプリ（GUI）の作り方

> すべてのコンポーネントを Root からなる階層構造下に置き、各コンポーネントは MVP パターンの
> Passive View として描画に関わるパラメータだけを操作し、動作は Chain of Responsibility で
> イベントをバブリングさせて、ステートマシンとして振る舞う Mediator に裁定させること。

この一文がこのディレクトリの規約である。以下はそれを、判断に使える形に開いたものである。
画面に出るもの（配置・見た目・キーボード・未読と知らせの扱い）の仕様は [ADR 0010](../docs/adr/0010-mac-app-structure.md)
（会話のウインドウは [ADR 0021](../docs/adr/0021-the-input-and-the-history-in-one-window.md)）、
この構造そのものの理由は [ADR 0015](../docs/adr/0015-mac-ui-passive-view-tree.md) にある。

## 1. Root からなる階層構造

- 画面に出るものはすべて `Component` として木に属し、根は `RootComponent` ひとつである。
  親が子を作り、子は親を弱く持つ。`adopt` で親子にし、木の形は生涯変わらない。
- 5 つの部品（キャラクター・返事の吹き出し・知らせの束・会話のウインドウ・設定）が Root の直下の子である。
  部品の中でイベントを出す部分は、さらにその子にする。
  **キャラクター・吹き出し・知らせの束は、Root が持つ 1 枚の透明なウインドウ（舞台）の中の View として描く**
  （ADR 0016）。この 3 つのコンポーネントはウインドウを持たず、Props から自分の View を作って Root に渡す。
  会話のウインドウと設定は自分のウインドウを持つ。いまある子は、キャラクターの印、
  吹き出しの本文・×・「続きは履歴で」、知らせのカード・×・「続きは履歴で」、会話のウインドウの文字の欄・履歴のひらく⇔とじるのボタンである。
- **木の外から個々のコンポーネントを掴まない。** アプリが持ってよいのは Root だけで、`AppDelegate` もそれしか持たない。
  新しいパネルを足すときは、Root の子として作り、Root から描画パラメータを渡す。
- メニューバーの scene だけは SwiftUI の都合で値を渡せないので、`MenuBarModel` が最後に渡された
  描画パラメータを持つ。これは受け渡しの箱であり、状態ではない。

## 2. Passive View（MVP）

- View が受け取るのは、**自分の描画パラメータ（Props）と、イベントを出す口（`EventSink`）だけ**である。
- **View にドメインの型を渡さない。** `ConversationState`・`ShownMessage`・`SessionMachine`・`AccountStore` を
  View の引数にしない。件数・本文・有効かどうか・tooltip の文言まで、すべて Props にして渡す。
- View の中の分岐は「この値をどう描くか」に限る。「次に何が起きるべきか」を決めない。
  ボタンに出す文言と、それが出すイベントは Props（`ActionProps`）に入っており、View はそれを描いて投げるだけである。
- 状態に依らない固定の見出し（「お知らせ」「話しかける（Shift+Enter で改行）」など）は View に置いてよい。
  **状態で変わる文言は Props に入れる。**
- View は状態を持たない。SwiftUI の `@State` は、描画に閉じたものに限り、理由をコメントに書く。
  いま許しているのは、入力欄の下書き（入力メソッドの変換中は AppKit の側にあるべきもの）と、
  設定の文字の欄（保存のボタンで初めて確定するもの）だけである。
- Props は値型で `Equatable` にし、**`UIProps` の純粋関数だけが作る。** 導出は `NatsumiCore` に置き、テストする。
  Root は Props が変わったときだけ描き直す。この比較が、描画→計測→描画の堂々巡りを止めている。

## 3. Chain of Responsibility

- 利用者の操作は `UIEvent` として、**それが起きたコンポーネントから** `dispatch` する。
  吹き出しの本文のクリックは吹き出しの本文のコンポーネントから、会話のウインドウの ⌘W はそのウインドウから出す。
- コンポーネントが処理しなければ、そのまま親へ渡る。Root まで上がったものは Mediator へ渡る。
- **途中で握りつぶしてよいのは、自分の描画パラメータだけで完結するものに限る。** 既定は「握りつぶさない」。
  `Component.handle` の既定は `false` であり、いまこれを `true` にしているのは Root だけである。
  握りつぶす箇所を作るなら、理由をコメントに書く。
- サーバーから来る出来事（envelope・接続の状態・ログインの結果・アバターの読み込み）も、同じ `UIEvent` の形で
  Root から Mediator へ入れる。**入口を 2 本にしない。**
- イベントは 1 件ずつ順に裁定する。効果が次のイベントを生むので、Root は入れ子にせずに待ち行列に積む。
  パネルが画面に出ていないと成り立たない効果（入力欄に焦点を移す、設定を出す）だけは、
  描き終えてから実行する。

## 4. ステートマシンとしての Mediator

- `UIMediator` は `(State, Event) -> (State, [Effect])` の純粋な状態機械である。
  **AppKit・SwiftUI・ネットワーク・`UserDefaults`・Keychain・`Bundle` に依存しない。** `NatsumiCore` に置く。
- `UIState` から Props を導出する。**Mediator の外で Props を作らない。**
- `UIEffect` は外の世界への指示である。**実行するのは Root だけ**であり、Mediator は実行しない。
  結果が要るものは、Root がイベントにして返す（`.resumeSession` には `.sessionResumed`、
  `.loadAvatar` には `.avatarLoaded`、`.startLogin` には `.loginFinished` が返る）。
- 接続と同期は `SessionMachine` の担当であり、これは別の関心事として残す。
  Mediator はソケットの出来事をそのまま渡し、返ってきた `SessionEffect` を自分の `UIEffect` として出す。
- 乱数（requestId）は生成器を差し込む形にし、テストでは決まった値を返す。Mediator の中で `UUID()` を呼ばない。
- **アニメーションは Root が持つ。** Mediator が決めるのは「どこへ動かすか」だけで、見せ方は Root が与える。
  Root は描画パスごとに `StageTransition`（即座・カードの開閉・走り）を選び、舞台の View がそれを時間と曲線に
  変える。長さは `NatsumiCore`（`CardAnimation.duration`・`CharacterRun.duration`）にそろえる。
  **ウインドウの枠をアニメーションさせない。** 動くものはすべて舞台の中の View である。
  例外は会話のウインドウの履歴の開閉だけで（ADR 0021）、Root が `NSAnimationContext` で枠を動かす。
  その間に届くウインドウの移動・大きさの変更の通知は Mediator に入れず、終わってから 1 回だけ枠を知らせる。
- **画面の座標は Root が知らせる。** キャラクターの枠と表示できる範囲、会話のウインドウの枠は `UIEvent` で Mediator に入れ、状態として持つ。
  会話のウインドウをどこに置くか（初回はキャラクターの真下、開閉は上下に均等）は `NatsumiCore` の純粋関数が決め、Root は置くだけである。
  Mediator が `NSScreen` を見に行かない。生の座標の流れ（マウスの移動など）は Root で間引き、Mediator には
  「近づいた」「離れた」のような意味のイベントだけを渡す。

## ファイルの置きどころ

| 置き場所 | 中身 |
|---|---|
| `NatsumiCore/UI/Component.swift` | `Component`（木とバブリング）、`EventSink` |
| `NatsumiCore/UI/UIEvent.swift` | `UIEvent`、`LaunchInfo`、`LoginOutcome` |
| `NatsumiCore/UI/UIEffect.swift` | `UIEffect` |
| `NatsumiCore/UI/UIState.swift` | `UIState`、`ConnectionStatus` |
| `NatsumiCore/UI/UIMediator.swift` | 裁定そのもの |
| `NatsumiCore/UI/Props.swift` | `RootProps` と各パネルの Props、`ColumnPlacement`、`UIProps` の導出 |
| `NatsumiCore/UI/Stacks.swift` | 束の数え方（`ReplyStack`・`NoticeStack`・`BalloonText`・`CharacterBadge`） |
| `NatsumiCore/UI/StageProps.swift` | 舞台の描画パラメータ（`StageProps`・`StageTransition`）と舞台の座標への変換 |
| `NatsumiCore/Overlay/` | 配置の計算（`OverlayLayout`）、大きさ（`CharacterScale`・`OverlaySettings`）、会話のウインドウの大きさと置き場所（`ConversationWindow`・`ConversationPlacement`）、走っての移動とポインタを避ける規則（`CharacterRun`・`PointerDodge`） |
| `Natsumi/Components/` | Root と各部品のコンポーネント、`OverlayPanel` と hosting view、キャラクターのマウスの受け口（`CharacterMouseArea`） |
| `Natsumi/Views/` | SwiftUI の Passive View、舞台（`StageView`）、`Comic` の見た目 |
| `Natsumi/Adapters/` | OS に触る部分（WebSocket・GitHub ログイン） |

名前の付け方は、パネルのコンポーネントが `<名前>Component`、その View が `<名前>View`、
その描画パラメータが `<名前>Props` である。子のコンポーネントの名前は `"balloon.close"` のように親から辿れる形にする。

## やってはいけない形

- View がドメインの型（`ConversationState`・`ShownMessage`・`AccountStore` など）を受け取る。
- View が分岐で動作を決める（「未読があれば既読にする、なければ閉じる」を View で書く）。
- コンポーネントを木の外から掴む。Root 以外を `AppDelegate` やアダプタが持つ。
- Mediator の外で Props を作る。View の中で件数や文言を組み立てる。
- Mediator に I/O を持たせる。`UserDefaults`・Keychain・`Bundle`・`URLSession`・`NSScreen` を触る。
- サーバーの出来事を Root を通さずに Mediator へ入れる。入口を増やす。

## テスト

- Mediator・Props の導出・木の伝播は、**すべて `NatsumiCoreTests` でテストする。** UI なしで確かめられることが、
  この構造を選んだ理由のひとつである（`UIMediatorTests`・`PropsTests`・`ComponentTests`）。
- テストは先に書く。期待する入出力を書き、失敗を見てから実装する。実装に合わせてテストを書き換えない。
- build とテストのコマンドは [README](../README.md) にある。Keychain を使うテストがあるので、ログイン中の GUI の
  セッションで実行する。
