import AppKit
import NatsumiCore
import SwiftUI

@main
struct NatsumiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra("natsumi", systemImage: "face.smiling") {
            MenuContent(model: delegate.model, openConversation: { delegate.showConversation() })
        }
        Settings {
            SettingsView(model: delegate.model)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model: AppModel
    private var character: CharacterPanelController?
    private var conversation: ConversationWindowController?

    override init() {
        model = AppModel()
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        model.launch()
        conversation = ConversationWindowController(model: model)
        character = CharacterPanelController(model: model) { [weak self] in self?.toggleConversation() }
    }

    func toggleConversation() {
        conversation?.toggle(near: character?.frame)
    }

    func showConversation() {
        conversation?.show(near: character?.frame)
    }
}

struct MenuContent: View {
    let model: AppModel
    let openConversation: () -> Void

    var body: some View {
        Text(model.statusText)
        Button("会話を開く", action: openConversation)
        if model.status == .needsLogin {
            Button("GitHub でログイン") { Task { await model.login() } }
        }
        SettingsLink { Text("設定…") }
            .keyboardShortcut(",")
        Button("ログアウト") { Task { await model.logout() } }
            .disabled(!model.hasSession)
        Divider()
        Button("終了") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
