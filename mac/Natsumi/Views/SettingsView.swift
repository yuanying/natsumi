import NatsumiCore
import SwiftUI

struct SettingsView: View {
    let props: SettingsProps?
    let send: EventSink
    /// Text being typed. It is drawing-local: what counts is what the owner commits with the buttons below.
    @State private var server = ""
    @State private var avatarPath = ""

    var body: some View {
        if let props {
            Form {
                Section("サーバー") {
                    TextField("URL", text: $server, prompt: Text("https://natsumi.example.net"))
                        .onSubmit { send(.serverSubmitted(server)) }
                    HStack {
                        if let message = props.message {
                            Text(message).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("保存") { send(.serverSubmitted(server)) }
                    }
                }
                Section("アカウント") {
                    Text(props.statusText)
                    if let error = props.lastError { Text(error).font(.caption).foregroundStyle(.red) }
                    HStack {
                        Button("GitHub でログイン") { send(.loginRequested) }
                            .disabled(!props.canLogin)
                        Button("ログアウト") { send(.logoutRequested) }
                            .disabled(!props.canLogout)
                    }
                }
                Section("キャラクター") {
                    LabeledContent("大きさ") {
                        HStack {
                            Slider(
                                value: Binding(
                                    get: { props.scale.value },
                                    set: { send(.characterScaleChanged(CharacterScale($0))) }),
                                in: CharacterScale.range, step: CharacterScale.step)
                            Text("\(props.scale.percent)%")
                                .monospacedDigit()
                                .frame(width: 48, alignment: .trailing)
                        }
                    }
                }
                Section("ショートカット") {
                    LabeledContent("会話のウインドウを出す") {
                        HStack {
                            Button(props.isRecordingHotKey ? "キーを押してください…" : props.hotKey) {
                                send(props.isRecordingHotKey ? .hotKeyRecordingCancelled : .hotKeyRecordingRequested)
                            }
                            .monospacedDigit()
                            Button("なし") { send(.hotKeyCleared) }
                                .disabled(!props.canClearHotKey)
                            Button("既定に戻す") { send(.hotKeyResetRequested) }
                                .disabled(!props.canResetHotKey)
                        }
                    }
                    if let message = props.hotKeyMessage {
                        Text(message).font(.caption).foregroundStyle(.red)
                    }
                    Text("どのアプリを使っていても効きます。ほかのアプリの同じショートカットより優先されます。ボタンを押してから、新しい組み合わせを押してください（Esc でやめる）。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("アバター") {
                    TextField("アセットのディレクトリ", text: $avatarPath)
                    Text(props.avatarDescription).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Spacer()
                        Button("既定に戻す") { send(.avatarDirectoryResetRequested) }
                        Button("読み込み直す") { send(.avatarDirectorySubmitted(avatarPath)) }
                    }
                }
            }
            .formStyle(.grouped)
            .frame(width: 480)
            .onAppear {
                server = props.serverOrigin
                avatarPath = props.avatarDirectory
            }
            // What was saved is what the fields show; a rejected URL leaves what was typed alone.
            .onChange(of: props.serverOrigin) { server = props.serverOrigin }
            .onChange(of: props.avatarDirectory) { avatarPath = props.avatarDirectory }
        }
    }
}
