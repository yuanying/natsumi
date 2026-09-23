import Foundation

/// Where an event is thrown in. A component hands one out so that a view can raise an event without knowing who
/// will answer it, or that anyone will.
public struct EventSinkOf<Event: Sendable>: Sendable {
    private let action: @MainActor @Sendable (Event) -> Void

    public init(_ action: @escaping @MainActor @Sendable (Event) -> Void) {
        self.action = action
    }

    @MainActor
    public func callAsFunction(_ event: Event) {
        action(event)
    }

    /// Drops everything. Used while a panel is measured, where no one is meant to act on what is drawn.
    public static var ignored: Self { Self { _ in } }
}

/// A node of the one tree the whole UI lives in.
///
/// A component draws with the parameters it is given and raises events; it decides nothing. An event travels from
/// the component it happened in towards the root, and every component on the way may answer it. The root answers
/// everything, so the chain always ends there.
///
/// The Mac and the iPhone each have their own events, so the tree is the same shape over either of them.
@MainActor
open class TreeComponent<Event: Sendable> {
    public let name: String
    public private(set) weak var parent: TreeComponent<Event>?
    public private(set) var children: [TreeComponent<Event>] = []

    public init(name: String) {
        self.name = name
    }

    /// Puts a component under this one. A component belongs to one parent for its whole life.
    public func adopt(_ child: TreeComponent<Event>) {
        precondition(child.parent == nil, "\(child.name) already has a parent")
        child.parent = self
        children.append(child)
    }

    /// Raises an event here. It goes up until a component answers it.
    public final func dispatch(_ event: Event) {
        guard !handle(event) else { return }
        parent?.dispatch(event)
    }

    /// Answers an event, or lets it pass. Swallowing is only for what a component settles with its own drawing
    /// parameters; the default is to let everything through to the mediator at the root.
    open func handle(_ event: Event) -> Bool { false }

    /// The port this component's views raise events through.
    public var sink: EventSinkOf<Event> {
        EventSinkOf { [weak self] event in self?.dispatch(event) }
    }
}

/// The Mac's tree.
public typealias Component = TreeComponent<UIEvent>
public typealias EventSink = EventSinkOf<UIEvent>
