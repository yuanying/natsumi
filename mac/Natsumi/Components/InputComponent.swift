import AppKit
import NatsumiCore
import SwiftUI

/// The input field under the character: the text field, the history button and the grip each raise their own
/// events. The panel itself raises what belongs to the whole of it (the connection's button, a failed message).
@MainActor
final class InputComponent: Component {
    let panel = OverlayPanel.make(acceptsKey: true)
    private let field = Component(name: "input.field")
    private let historyButton = Component(name: "input.historyButton")
    private let grip = Component(name: "input.grip")
    private var applied: InputProps?
    private var hosting: FirstMouseHostingView<InputView>!

    init() {
        super.init(name: "input")
        adopt(field)
        adopt(historyButton)
        adopt(grip)
        hosting = FirstMouseHostingView(rootView: view(nil))
        panel.contentView = hosting
        panel.onCancel = { [weak self] in self?.dispatch(.inputEscaped) }
    }

    func view(_ props: InputProps?) -> InputView {
        InputView(props: props, field: field.sink, historyButton: historyButton.sink, grip: grip.sink, send: sink)
    }

    /// The same drawing, for measuring only: the height it reports here would not be the one on the screen.
    func probe(_ props: InputProps) -> InputView {
        InputView(props: props, field: .ignored, historyButton: .ignored, grip: .ignored, send: .ignored)
    }

    func render(_ props: InputProps?) {
        guard props != applied else { return }
        applied = props
        hosting.rootView = view(props)
    }

    /// Puts the caret in the text field.
    func focus() {
        panel.makeKey()
        if let text = panel.contentView?.descendant(withIdentifier: InputTextView.identifier) {
            panel.makeFirstResponder(text)
        }
    }
}
