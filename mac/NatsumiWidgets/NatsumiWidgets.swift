import AppIntents
import SwiftUI
import WidgetKit

/// Ways to open the app from the lock screen: a button for its bottom corners
/// (also Control Center and the Action button) and a face under the clock.
/// Both only open the app; they show nothing of the conversation.
@main
struct NatsumiWidgets: WidgetBundle {
    var body: some Widget {
        LaunchControl()
        LaunchWidget()
    }
}

struct LaunchControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "io.github.yuanying.natsumi.phone.launch-control") {
            ControlWidgetButton(action: OpenNatsumiIntent()) {
                Label("なつみ", systemImage: "bubble.left.fill")
            }
        }
        .displayName("なつみを開く")
        .description("なつみのアプリを開きます。")
    }
}

struct LaunchWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "io.github.yuanying.natsumi.phone.launch-widget", provider: LaunchTimeline()) { _ in
            LaunchWidgetView()
        }
        .configurationDisplayName("なつみ")
        .description("タップするとなつみのアプリを開きます。")
        .supportedFamilies([.accessoryCircular])
    }
}

/// The face never changes, so the timeline is a single entry.
struct LaunchTimeline: TimelineProvider {
    func placeholder(in context: Context) -> LaunchEntry { LaunchEntry(date: .now) }

    func getSnapshot(in context: Context, completion: @escaping (LaunchEntry) -> Void) {
        completion(LaunchEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LaunchEntry>) -> Void) {
        completion(Timeline(entries: [LaunchEntry(date: .now)], policy: .never))
    }
}

struct LaunchEntry: TimelineEntry {
    let date: Date
}

struct LaunchWidgetView: View {
    var body: some View {
        Image("Face")
            .resizable()
            .widgetAccentedRenderingMode(.fullColor)
            .scaledToFill()
            .clipShape(Circle())
            .containerBackground(for: .widget) { AccessoryWidgetBackground() }
            .accessibilityLabel("なつみを開く")
    }
}
