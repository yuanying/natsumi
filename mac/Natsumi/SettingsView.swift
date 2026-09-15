import NatsumiCore
import SwiftUI

struct SettingsView: View {
    let model: AppModel
    @State private var server = ""
    @State private var serverMessage: String?
    @State private var avatarPath = ""

    var body: some View {
        Form {
            Section("サーバー") {
                TextField("URL", text: $server, prompt: Text("https://natsumi.example.net"))
                    .onSubmit(saveServer)
                HStack {
                    if let serverMessage { Text(serverMessage).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button("保存", action: saveServer)
                }
            }
            Section("アカウント") {
                Text(model.statusText)
                if let error = model.lastError { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button("GitHub でログイン") { Task { await model.login() } }
                        .disabled(model.status != .needsLogin)
                    Button("ログアウト") { Task { await model.logout() } }
                        .disabled(!model.hasSession)
                }
            }
            Section("アバター") {
                TextField("アセットのディレクトリ", text: $avatarPath)
                Text(model.avatarDescription).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("既定に戻す") {
                        avatarPath = AppModel.defaultAvatarDirectory.path
                        model.avatarDirectoryPath = avatarPath
                    }
                    Button("読み込み直す") { model.avatarDirectoryPath = avatarPath }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .onAppear {
            server = model.serverOrigin
            avatarPath = model.avatarDirectoryPath
        }
    }

    private func saveServer() {
        do {
            try model.saveServer(server)
            server = model.serverOrigin
            serverMessage = "保存しました"
        } catch ServerAddressError.insecure {
            serverMessage = "http は localhost などのループバックだけで使えます。https の URL を入れてください"
        } catch {
            serverMessage = "https://ホスト名[:ポート] の形で入れてください"
        }
    }
}
