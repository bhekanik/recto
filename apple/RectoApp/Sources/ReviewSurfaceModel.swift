import Foundation
import Observation
import RectoHistory
import RectoSync

/// The web's review surface without the view: open suggestion branches, the
/// diff of the one being read, and accepting all of it, some of it, or none.
@MainActor
@Observable
final class ReviewSurfaceModel {
    private(set) var branches: [RemoteBranch] = []
    private(set) var selectedId: String?
    private(set) var diff: RemoteBranchDiff?
    /// Review each change on its own; off accepts the branch whole.
    var perHunk = false
    /// Hunk indices to accept, all of them to begin with (the web's default).
    var accepted: Set<Int> = []
    var errorMessage: String?

    @ObservationIgnored private var cloud: CloudDocumentContext?
    @ObservationIgnored private var subscription: Task<Void, Never>?

    func runs(granularity: DiffGranularity) -> [DiffRun] {
        guard let diff else { return [] }
        return diffRuns(diff.currentMarkdown, diff.branchMarkdown, granularity: granularity)
    }

    func hunks(granularity: DiffGranularity) -> [DiffHunk] {
        groupHunks(runs(granularity: granularity))
    }

    func follow(_ cloud: CloudDocumentContext?) {
        self.cloud = cloud
        subscription?.cancel()
        guard let cloud, let convexId = cloud.convexId else { return }
        subscription = Task { [weak self] in
            let stream: AsyncThrowingStream<[RemoteBranch], any Error> =
                await cloud.api.subscribe(ConvexFunction.reviewListOpenBranches, args: ["documentId": .string(convexId)])
            do {
                for try await list in stream { self?.branches = list }
            } catch {
                self?.errorMessage = error.localizedDescription
            }
        }
    }

    func stop() {
        subscription?.cancel()
        subscription = nil
    }

    func select(_ branch: RemoteBranch, granularity: DiffGranularity) async {
        guard let cloud, let convexId = cloud.convexId else { return }
        selectedId = branch.id
        diff = nil
        perHunk = false
        do {
            diff = try await cloud.api.query(
                ConvexFunction.reviewGetBranchDiff,
                args: ["documentId": .string(convexId), "branchId": .string(branch.id)])
            accepted = Set(hunks(granularity: granularity).map(\.index))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggle(_ hunk: Int) {
        if accepted.contains(hunk) { accepted.remove(hunk) } else { accepted.insert(hunk) }
    }

    /// The web's accept: whole branch unless reviewing each change with some
    /// left out, in which case only the accepted hunks merge.
    func accept(granularity: DiffGranularity) async {
        guard let selectedId, let convexId = cloud?.convexId else { return }
        let total = hunks(granularity: granularity).count
        if perHunk, accepted.count < total {
            await mutate(ConvexFunction.reviewAcceptHunks, [
                "documentId": .string(convexId), "branchId": .string(selectedId),
                "granularity": .string(granularity.rawValue),
                "acceptedHunks": .array(accepted.sorted().map { .number(Double($0)) }),
            ])
        } else {
            await mutate(ConvexFunction.reviewAcceptBranch, ["documentId": .string(convexId), "branchId": .string(selectedId)])
        }
    }

    func reject() async {
        guard let selectedId, let convexId = cloud?.convexId else { return }
        await mutate(ConvexFunction.reviewRejectBranch, ["documentId": .string(convexId), "branchId": .string(selectedId)])
    }

    private func mutate(_ name: String, _ args: [String: ConvexValue]) async {
        guard let cloud else { return }
        do {
            let _: ConvexVoid = try await cloud.api.mutation(name, args: args)
            selectedId = nil
            diff = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
