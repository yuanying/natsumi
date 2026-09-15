import Foundation

/// A message the owner sent that the server has not recorded yet.
public struct OutgoingMessage: Equatable, Identifiable, Sendable {
    public enum Status: Equatable, Sendable {
        case sending
        case rejected(String)
        case unavailable(String)
    }

    public let requestId: String
    public let text: String
    public var status: Status

    public init(requestId: String, text: String, status: Status) {
        self.requestId = requestId
        self.text = text
        self.status = status
    }

    public var id: String { requestId }
}

/// What the conversation window shows, built only from server events and the owner's own unsent messages.
public struct ConversationState: Equatable, Sendable {
    public private(set) var messages: [ShownMessage] = []
    /// Owner messages natsumi has not finished with, by event ID.
    public private(set) var pendingEvents: [String: EventState] = [:]
    public private(set) var expression: Expression = .neutral
    public private(set) var outbox: [OutgoingMessage] = []
    /// Counts the snapshots applied, so a view can tell messages that came back in one from ones that just arrived.
    public private(set) var snapshotGeneration = 0

    public init() {}

    /// natsumi has owner messages still to handle. The face is not used: the model can leave the thinking face after
    /// it has finished, and the server only puts back a face it set itself.
    public var isThinking: Bool { !pendingEvents.isEmpty }

    /// Messages to send (again) once the connection is synced. The server answers a resent requestId with the same result.
    public var unsent: [OutgoingMessage] { outbox.filter { $0.status == .sending } }

    public mutating func enqueue(text: String, requestId: String) {
        outbox.append(OutgoingMessage(requestId: requestId, text: text, status: .sending))
    }

    public mutating func dismiss(requestId: String) {
        outbox.removeAll { $0.requestId == requestId }
    }

    public mutating func apply(_ event: ServerEvent, requestId: String? = nil) {
        switch event {
        case .snapshot(let snapshot):
            messages = snapshot.messages
            snapshotGeneration += 1
            pendingEvents = Dictionary(
                snapshot.pendingEvents.filter { $0.state.isPending }.map { ($0.eventId, $0.state) },
                uniquingKeysWith: { _, latest in latest })
            expression = snapshot.expression
        case .message(let message):
            guard !messages.contains(where: { $0.messageId == message.messageId }) else { return }
            messages.append(message)
            if message.kind == .message, let eventId = message.eventId, pendingEvents[eventId] == nil {
                pendingEvents[eventId] = .queued
            }
        case .expression(let expression):
            self.expression = expression
        case .eventCompleted(let completion):
            pendingEvents[completion.eventId] = nil
        case .accepted(let accepted):
            guard let index = outboxIndex(requestId) else { return }
            outbox.remove(at: index)
            if let eventId = accepted.eventId, let state = accepted.state {
                if state.isPending {
                    pendingEvents[eventId] = pendingEvents[eventId] ?? state
                } else {
                    pendingEvents[eventId] = nil
                }
            }
        case .rejected(let code):
            if let index = outboxIndex(requestId) { outbox[index].status = .rejected(code) }
        case .unavailable(let code, _):
            if let index = outboxIndex(requestId) { outbox[index].status = .unavailable(code) }
        }
    }

    private func outboxIndex(_ requestId: String?) -> Int? {
        guard let requestId else { return nil }
        return outbox.firstIndex { $0.requestId == requestId }
    }
}
