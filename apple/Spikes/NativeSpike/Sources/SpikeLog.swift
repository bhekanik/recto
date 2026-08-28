import Foundation
import Observation

/// stdout is the evidence channel: the Mac app is run from a terminal and the
/// iPad build through `simctl launch --console-pty`, so every log line ends up
/// in a capture file. The same lines feed the in-app view for screenshots.
enum SpikeLog {
  static func line(_ tag: String, _ message: String) {
    let text = "\(Date.now.ISO8601Format()) [\(tag)] \(message)"
    print("SPIKE \(text)")
    fflush(stdout)
    Task { @MainActor in SpikeLogBuffer.shared.append(text) }
  }
}

@MainActor @Observable
final class SpikeLogBuffer {
  static let shared = SpikeLogBuffer()

  private(set) var lines: [String] = []

  func append(_ line: String) {
    lines.append(line)
    if lines.count > 500 { lines.removeFirst(lines.count - 500) }
  }
}
