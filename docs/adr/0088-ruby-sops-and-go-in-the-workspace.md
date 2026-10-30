# 0088. 作業環境に Ruby・sops・age・Go を入れる

- Date: 2026-10-30
- Status: Accepted

## Context

クラスタの運用を受け持つインスタンスは、試験用のクラスタを自分で立てて壊す（[ADR 0085](0085-relays-that-add-the-keys-for-the-workspace.md)）。
立てる道具は Ruby の CLI で、作業環境の中で clone から `bundle install` して使う。
その依存には C 拡張の gem が含まれる。また、その CLI は、出力する secret を sops と age で暗号化できる。
本人は、Go の道具も作業環境で build できるようにしておきたいとした。

今の作業環境には、どれも無い。

- Ruby・C のコンパイラ・sops・age・Go が入っていない。
- ルートは読み取り専用である。書けるのは `/memory`・`/work`・`/home/natsumi`・`/tmp` だけである（[ADR 0019](0019-a-workspace-not-a-memory-tool.md)）。
- runner は、コマンドに `PATH`・`HOME`・`LANG`・`TZ` しか渡さない（ADR 0019）。`GEM_HOME`・`BUNDLE_*`・`SOPS_AGE_KEY_FILE`・`GO*` のような環境変数は、image に書いても届かない。
- 作業環境は、Kubernetes では image とは別の UID（1001）で動く（[ADR 0033](0033-running-on-kubernetes.md)）。

gem・Go のモジュールの取り込みは、インスタンスの配置が選ぶ中継を通す（ADR 0085 と同じ形）。中継とその設定は環境の設定の側で決め、ここでは扱わない。

## Decision

### 全員の作業環境の image に入れる

- ADR 0085 の `kubectl` と同じく、全員の作業環境の image に入れる。外向きが閉じたインスタンスでは、gem もモジュールも取れないが、手元のものの build と実行はできる。
- 選んだインスタンスにだけ届ける形は、配置の仕組みを増やすだけで守りを強めない（ADR 0085 と同じ理由）。

### Ruby は Debian のもの、C のコンパイラは最小にする

- Ruby は Debian bookworm の `ruby`・`ruby-dev`（3.1）を入れる。
- C 拡張の build には `gcc`・`make`・`libc6-dev` を入れる。`build-essential` は入れない。足されるのは `g++` と `dpkg-dev` で、C の拡張には要らない。C++ の拡張の gem は build できない。

### bundler は版を固定して入れ、PATH の bundle をラッパーにする

- Debian の bundler（2.3）は入れない。gemspec の開発用の依存に、もっと新しい bundler を求めるものがあり、その場合は解決の段階で止まる。
- bundler は rubygems.org から版を固定して入れる。Ruby 3.1 で動く最後の系列の 2.6 にする（2.7 以降は Ruby 3.2 を求める）。
  版は Dockerfile の `ARG` に書き、Renovate が gem として上げる。2.7 以上には上げない規則を置き、image の Debian を上げるときに外す。
- 本物の bundler は PATH の外に置く。PATH の `bundle`・`bundler` は、`GEM_HOME` を Ruby の `Gem.user_dir`（`HOME` の下）に向けて本物を動かすラッパーにする。
  - 何も設定しなければ、bundler は Ruby の既定の場所（読み取り専用のルートの下）に書こうとして失敗する。
  - bundler 2.6 には、全員の既定を置ける設定ファイル（`/etc` の下など）が無い。読むのは環境変数・`HOME` の設定・プロジェクトの設定だけで、`HOME` は mount で image の中身が隠れる。
  - `Gem.user_dir` は Ruby の既定の gem の探し場所に入っている。`bundle install` で入れた gem は、`bundle exec` でなくても素の `ruby` から読める。
  - 既に `GEM_HOME` があればそれを使う。プロジェクトの bundler の設定（`path`）もラッパーより優先される。
  - `bundle config` の global の設定（mirror など）は、これまでどおり `HOME` の下に書けて残る。
- 退けた案:
  - **プロジェクトの `vendor/bundle` を既定にする**: 全員に既定を置く手段が、結局ラッパーになる。入れたものが `bundle exec` の外から見えず、clone ごとに入れ直しになる。
  - **Ruby の既定の場所を書ける場所への symlink にする**: mount が空のときに壊れ、bundler 自身の置き場とも重なる。
- `gem install` は対象にしない。`--user-install` を付ければ同じ `Gem.user_dir` に入る。

### sops は公開の配布物から、age は Debian から

- sops は Debian bookworm に無い。`kubectl` と同じく、GitHub のリリースから版を固定して取り、一緒に公開されているチェックサムで確かめる。amd64・arm64 の両方に対応する。
  版は `ARG` に書き、Renovate が getsops/sops のリリースとして上げる。
- age（`age`・`age-keygen`）は Debian bookworm のもの（1.1）を入れる。
  - age のリリースは、照合できるチェックサムを公開していない。Debian の package なら apt が署名で確かめる。
  - 作業環境で age の CLI を使うのは、鍵を作るときだけである。暗号化と復号は sops が自分で持つ age の実装で行う。1.1 で足りる。
- 鍵の置き場は、`SOPS_AGE_KEY_FILE` を使わずに、sops が既定で読む `HOME` の下（`~/.config/sops/age/keys.txt`）にする。runner が環境変数を渡さないためである。
  ラッパーは置かない。既定の置き場で足り、ほかの置き場を使うときは、コマンドの行で環境変数を付ければよい。

### Go は golang の image のものを入れ、別の版を取りに行かない

- Go のツールチェーンは、runner と sdctl の build に使っている golang の image から `/usr/local/go` をそのまま入れる。
  Renovate は今の Dockerfile の読み方で、3 つの stage を同じ版に上げる。runner の Go と作業環境の Go がずれない。
- runner の `PATH` に `/usr/local/go/bin` は無い。`go`・`gofmt` を `/usr/local/bin` に link する。
- `GOPATH`・`GOMODCACHE`・`GOCACHE` は Go の既定のままにする。どれも `HOME` の下に落ちる。
- `GOTOOLCHAIN` は `local` を既定にする。go.mod の `go`・`toolchain` の行が新しい版を求めても、別のツールチェーンを取りに行かずに止まる。
  - 置き場は `$GOROOT/go.env` である。Go の既定のうちで一番弱く、環境変数と `go env -w`（`HOME` の下の設定）のほうが勝つ。
  - 別の版が要るときは、中継越しに `go env -w GOTOOLCHAIN=auto` などで取れる。
- `GOPROXY` は Go の出荷時の既定のままにし、image に中継の場所を書かない。中継のポートはインスタンスの配置が決める。設定は `go env -w` か環境の設定の側で行う。

### 手引きとプロンプトは変えない

- `run_shell` の説明と、プロンプトの「作業環境だけのコマンド」（[ADR 0056](0056-the-manual-index-and-the-workspace-commands-in-the-prompt.md)）には足さない。
  あの一覧は普通の Debian に無い、この作業環境だけのコマンドを、全員に同じ文で知らせるものである。Ruby・Go・sops はどれも普通の道具で、使うのは一部のインスタンスである。
  足せば全員の prefix が変わる（ADR 0085 の `kubectl` と同じ判断）。
- 使い方（mirror と GOPROXY の向け先、鍵の置き場）は、使うインスタンスの `/manual` の手引きで知らせる（[ADR 0036](0036-a-manual-to-read-and-a-limit-on-waiting.md)）。

## Consequences

- 作業環境の image が大きくなる。増えるのは主に Go のツールチェーンと、Ruby・C のコンパイラである。
- gem・Go のモジュール・ビルドのキャッシュは `HOME` の下に溜まり、永続する書き場所の大きさの目安（ADR 0019）に数えられる。片づけはなつみが行う。
- Ruby 3.1 は upstream の保守が終わっており、Debian bookworm のセキュリティ更新に頼る。bundler も Ruby 3.1 で動く 2.6 に留まる。どちらも image の Debian を上げるときに見直す。
- C++ の拡張の gem は build できない。要るようになったら `g++` を足す。
- 作業環境の中のどのコマンドも C のコンパイラと Go で任意の実行ファイルを作れる。これまでも python3 で任意のコードを動かせたので、閉じ込めの形（コンテナの形）は変わらない。
- `GOTOOLCHAIN=local` により、新しい Go を求めるモジュールは、image の Go を上げるか設定を変えるまで build できない。
