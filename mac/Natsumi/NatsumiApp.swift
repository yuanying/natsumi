import AppKit
import NatsumiCore
import SwiftUI

@main
struct NatsumiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra("natsumi", systemImage: "face.smiling") {
            MenuContent(
                model: delegate.model,
                talk: { delegate.overlay?.openInput() },
                openHistory: { delegate.overlay?.openHistory() })
        }
        Settings {
            SettingsView(model: delegate.model)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model: AppModel
    private(set) var overlay: OverlayController?

    override init() {
        model = AppModel()
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        model.launch()
        overlay = OverlayController(model: model)
    }
}

struct MenuContent: View {
    let model: AppModel
    let talk: () -> Void
    let openHistory: () -> Void

    var body: some View {
        Text(model.statusText)
        Button("話しかける", action: talk)
        Button("履歴を開く", action: openHistory)
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
