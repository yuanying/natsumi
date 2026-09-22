import NatsumiCore
import SwiftUI

@main
struct NatsumiPhoneApp: App {
    /// The only thing the app holds (ADR 0028).
    @State private var root: PhoneRootComponent
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let root = PhoneRootComponent()
        root.launch()
        _root = State(initialValue: root)
    }

    var body: some Scene {
        WindowGroup {
            ScreenView(model: root.model)
        }
        .onChange(of: scenePhase) { _, phase in root.scenePhaseChanged(phase) }
    }
}

/// Draws whichever screen the props say is up.
struct ScreenView: View {
    let model: ScreenModel

    var body: some View {
        switch model.props.screen {
        case .login(let props):
            LoginView(props: props, send: model.sinks.login)
        case .main(let props):
            MainView(props: props, sinks: model.sinks)
        }
    }
}
