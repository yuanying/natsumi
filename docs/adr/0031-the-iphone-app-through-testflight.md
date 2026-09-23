# 0031. iPhone のアプリを GitHub Actions でビルドし、TestFlight で配る

- Date: 2026-09-23
- Status: Accepted（最初の実行の結果、TestFlight 版で通知が届いたこと、開発版と TestFlight 版を共存させないことを末尾に追記）

## Context

iPhone のアプリ（[ADR 0028](0028-the-iphone-client.md)）は、本人が Mac の Xcode から USB で実機に入れている。
開発用の署名の期限が切れるたびに Mac につないで入れ直す必要があり、負担になっている。

有料の Apple Developer Program に入っているので、App Store Connect にアップロードし、TestFlight の内部テストで配れる。
iPhone の TestFlight アプリが新しいビルドを自動で入れるので、入れ直しの手間がなくなる。

決める必要があるのは次のことである。

- どこでビルドするか。macOS が要り、開発者の手元には Linux の環境しかないこともある
- 署名の方式。証明書と秘密鍵をどこに置くか
- いつビルドするか。TestFlight のビルドは 90 日で使えなくなる
- ビルド番号の付け方
- 輸出規制の申告（毎回 App Store Connect で答えるか、Info.plist で済ませるか）

## Decision

### GitHub Actions の macOS の runner でビルドする

- ワークフローは `.github/workflows/iphone-testflight.yml` に置く。
- 起動は 3 つ。手動（`workflow_dispatch`）、main への push（`mac/` のうち iPhone のアプリに入るものが変わったとき）、
  月 1 回の定期実行。月 1 回は、90 日の期限よりも十分に短い間隔として選んだ。
- `pull_request` では走らせない。このリポジトリは public であり、fork からの PR に署名の Secrets を渡さないためである。
- runner は `xcode-27` のイメージを使い、Xcode 27.0 を `DEVELOPER_DIR` で明示する。2026-09 の時点で Xcode 27 が入っているのは
  このイメージだけで、preview の扱いである。App Store Connect は beta の Xcode でビルドしたものを受け付けないので、
  イメージの既定が次の beta に替わっても 27.0 を使うよう、版の別名のパスで固定する。

### 署名は、配布を App Store Connect の API キーとクラウドの証明書に任せ、archive だけ開発用の証明書を使う

- `xcodebuild archive` と `-exportArchive` の両方に、App Store Connect の API キー（`-authenticationKeyPath` など）と
  `-allowProvisioningUpdates` を渡す。provisioning profile は xcodebuild が作り、更新する。
- 配布用の署名は、export のときにチームのクラウドで管理される配布用の証明書で行う。配布用の秘密鍵は手元にも Secrets にも置かない。
- archive は、プロジェクトの設定どおり自動署名の開発用（Apple Development）で署名する。**開発用の証明書は .p12 で Secrets に置き、
  使い捨ての keychain に入れてから archive する。**
  - keychain に開発用の証明書がないと、xcodebuild は runner ごとに新しい開発用の証明書を作る。runner は毎回まっさらなので、
    実行のたびに証明書が増え、アカウントの上限に達すると失敗する。2 回目以降の実行で「この機械の証明書はあるが秘密鍵がない」
    として失敗するという報告もある。
  - archive を署名なしで作って export でだけ署名する方法もあるが、署名のない archive からは entitlements
    （`aps-environment`、Keychain の共有グループ）が export に引き継がれない恐れがあり、確かめられていないので採らなかった。
  - プロジェクトの署名の設定（Team・Automatic）は変えない。
- API キーは App Store Connect の Team Key で、役割は Admin とする。クラウドで管理される配布用の証明書を使うのに要る。
- Secrets の名前は `ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`（.p8 を base64 にしたもの）・`APPLE_DEVELOPMENT_P12`
  （.p12 を base64 にしたもの）・`APPLE_DEVELOPMENT_P12_PASSWORD` とする。鍵と証明書は runner の一時ディレクトリに書き出し、
  ジョブの最後に keychain ごと消す。

### ビルド番号は run の番号、版は 1.0

- `CURRENT_PROJECT_VERSION` にワークフローの `github.run_number` を、`MARKETING_VERSION` に `1.0` をコマンドラインで渡す。
  コマンドラインの設定はすべてのターゲットに効くので、アプリ・拡張・framework の番号がそろう。
- プロジェクトのファイルには版とビルド番号を書かない。Xcode から実機に入れるときは今までどおりである。
- 版を上げるときは、ワークフローの `MARKETING_VERSION` を変える。

### TestFlight の内部テストだけに出す

- export の設定で内部テストだけに限る（`testFlightInternalTestingOnly`）。本人と、本人が足した App Store Connect の利用者にだけ届き、
  Beta App Review を通さない。

### 輸出規制は Info.plist で「免除に当たる暗号だけ」と申告する

- `NatsumiPhone/Info.plist` に `ITSAppUsesNonExemptEncryption` を `NO` で置く。
- アプリが使う暗号は、HTTPS と WSS（`URLSession`）、通知の本文の復号（CryptoKit の P-256 ECDH・HKDF-SHA256・AES-256-GCM）、
  ログインの PKCE（CryptoKit の SHA-256）である。どれも OS に入っている暗号を標準の方式で使うだけで、独自の暗号も、
  暗号のライブラリの同梱もない。アプリの主な機能は情報の保護ではない。
- Apple の文書は、`ITSAppUsesNonExemptEncryption` を `NO` にするのは暗号を使わないか、免除に当たる暗号だけを使う場合であり、
  OS に組み込まれた暗号の利用は通常その免除に当たる、としている。これに当たると判断した。

### APNs の送り先は変えない

- TestFlight のビルドは配布用に署名されるので、埋め込まれた provisioning profile の `aps-environment` は production になる。
  アプリは profile から送り先を決めて登録し（ADR 0029）、サーバーは登録の `environment` で送り先を選ぶので、サーバーの設定は変えない。

## Consequences

- iPhone に入るアプリは、main の最新から作られたものになる。Xcode から USB で入れたものと同じ bundle ID なので、どちらか後から入れた方に置き換わる。
- 開発用の証明書は 1 年で切れる。切れたら新しい .p12 で `APPLE_DEVELOPMENT_P12` を差し替える必要がある。
- 同じ run を再実行すると同じビルド番号になり、アップロードが断られる。作り直すときは新しい run を起こす。
- public のリポジトリでは、60 日間リポジトリに動きがないと、GitHub が定期実行のワークフローを止める。止まったらワークフローを
  有効にし直すか、手動で走らせる。自動で防ぐ仕組み（空のコミットなど）は入れない。
- `xcode-27` のイメージは preview であり、待ち時間が長くなることがある。Xcode 27 が一般のイメージ（`macos-27` など）に入ったら、
  そちらに移す。

## 追記: 最初の実行の結果（2026-09-23）

- 本人が Secrets の 5 つを登録したあと手動で走らせた [run 35832113315](https://github.com/yuanying/natsumi/actions/runs/35832113315)
  （run 番号 2）が、約 9 分で成功した。
- Xcode 27.0（`xcode-27` のイメージ。実体は `Xcode_27_Release_Candidate.app`）で archive と export が通り、
  1.0 (2) を App Store Connect にアップロードした。開発用の .p12 による archive の署名、クラウドの配布用証明書による
  export の署名、API キーでのアップロードが、この ADR の形のまま通ることを確かめた。
- APNs の鍵の環境は Sandbox & Production である（本人が確かめた）。
- 2026-09-23 に、本人が TestFlight 版の実機で通知が届くことを確かめた（送り先は production の APNs）。
- 開発版と TestFlight 版は bundle ID が同じで、共存しない。共存させる仕組み（別の bundle ID など）は作らない。
  開発中に実機で確かめるときだけ Xcode から上書きし、終わったら TestFlight から入れ直す（本人の決定）。
