import Testing
@testable import NatsumiCore

/// A component that records what reached it, and may answer.
@MainActor
private final class Recorder: Component {
    var seen: [UIEvent] = []
    var answers = false

    override func handle(_ event: UIEvent) -> Bool {
        seen.append(event)
        return answers
    }
}

@MainActor
@Suite("コンポーネントの木とイベントの伝播")
struct ComponentTests {
    /// root - panel - leaf
    private func tree() -> (root: Recorder, panel: Recorder, leaf: Recorder) {
        let root = Recorder(name: "root")
        let panel = Recorder(name: "panel")
        let leaf = Recorder(name: "leaf")
        root.adopt(panel)
        panel.adopt(leaf)
        return (root, panel, leaf)
    }

    @Test("親は木の中で一意に決まり、子は親から辿れる")
    func hierarchy() {
        let (root, panel, leaf) = tree()
        #expect(root.parent == nil)
        #expect(panel.parent === root)
        #expect(leaf.parent === panel)
        #expect(root.children.map(\.name) == ["panel"])
        #expect(panel.children.map(\.name) == ["leaf"])
    }

    @Test("イベントは起きたところから根まで上がる")
    func bubbles() {
        let (root, panel, leaf) = tree()
        leaf.dispatch(.characterClicked)
        #expect(leaf.seen == [.characterClicked])
        #expect(panel.seen == [.characterClicked])
        #expect(root.seen == [.characterClicked])
    }

    @Test("途中で答えたら、それより上には行かない")
    func swallowed() {
        let (root, panel, leaf) = tree()
        panel.answers = true
        leaf.dispatch(.characterClicked)
        #expect(panel.seen == [.characterClicked])
        #expect(root.seen.isEmpty)
    }

    @Test("イベントを出す口は、そのコンポーネントから dispatch する")
    func sink() {
        let (root, _, leaf) = tree()
        leaf.sink(.inputEscaped)
        #expect(root.seen == [.inputEscaped])
    }
}
