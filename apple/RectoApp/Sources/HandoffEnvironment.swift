import SwiftUI

private struct RectoWebOriginKey: EnvironmentKey {
    static let defaultValue: URL? = nil
}

extension EnvironmentValues {
    var rectoWebOrigin: URL? {
        get { self[RectoWebOriginKey.self] }
        set { self[RectoWebOriginKey.self] = newValue }
    }
}
