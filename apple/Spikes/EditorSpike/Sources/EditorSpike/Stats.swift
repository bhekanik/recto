import Darwin
import Foundation

struct Samples {
    private(set) var values: [Double] = []

    mutating func add(_ v: Double) { values.append(v) }

    var count: Int { values.count }
    var p50: Double { percentile(0.50) }
    var p95: Double { percentile(0.95) }
    var p99: Double { percentile(0.99) }
    var max: Double { values.max() ?? 0 }
    var mean: Double { values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count) }

    func percentile(_ q: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let idx = Int((Double(sorted.count - 1) * q).rounded())
        return sorted[idx]
    }

    func over(_ threshold: Double) -> Int { values.filter { $0 > threshold }.count }

    func line(_ label: String) -> String {
        String(
            format: "%-34@ n=%-5d p50=%6.2f  p95=%6.2f  p99=%6.2f  max=%7.2f  mean=%6.2f",
            label as NSString, count, p50, p95, p99, max, mean)
    }
}

/// Resident footprint of this process, the number Activity Monitor calls "Memory".
func footprintMB() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
        MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    guard kr == KERN_SUCCESS else { return 0 }
    return Double(info.phys_footprint) / 1_048_576
}

/// `phys_footprint` right after a document load catches a large transient peak
/// that the allocator gives back within a second or two. This is the number that
/// describes what the app actually holds.
@MainActor
func settledFootprintMB() -> Double {
    pump(2.0)
    return footprintMB()
}
