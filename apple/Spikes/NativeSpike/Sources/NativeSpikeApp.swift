import ClerkKit
import SwiftUI

@main
struct NativeSpikeApp: App {
  @State private var model = SpikeModel()

  init() {
    Clerk.configure(publishableKey: SpikeConfig.clerkPublishableKey)
  }

  var body: some Scene {
    WindowGroup {
      ContentView(model: model)
        .environment(Clerk.shared)
        .task { model.start() }
    }
    #if os(macOS)
      .defaultSize(width: 900, height: 700)
    #endif
  }
}
