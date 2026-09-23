import Foundation

/// `review.listShares`: someone the owner shared this document with.
struct RemoteShare: Decodable, Equatable, Identifiable, Sendable {
    enum Role: String, Decodable, Sendable, CaseIterable {
        case suggester, commenter

        /// The share dialog's words.
        var label: String { self == .suggester ? "Suggest" : "Comment" }
        var hint: String { self == .suggester ? "Comment + tracked changes" : "Leave comments only" }
    }

    let id: String
    let granteeEmail: String
    let role: Role
    let createdAt: Double

    private enum CodingKeys: String, CodingKey {
        case id = "_id"
        case granteeEmail, role, createdAt
    }
}

/// `review.listComments`.
struct RemoteComment: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let authorUserId: String
    let authorName: String
    let anchor: CommentAnchor
    let body: String
    let threadParentId: String?
    let resolved: Bool
    let createdAt: Double

    private enum CodingKeys: String, CodingKey {
        case id = "_id"
        case authorUserId, authorName, anchor, body, threadParentId, resolved, createdAt
    }
}

/// `review.listOpenBranches`: a reviewer's (or the AI's) suggested edits.
struct RemoteBranch: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let reviewerName: String
    let nodeCount: Double
    let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id = "_id"
        case reviewerName, nodeCount, updatedAt
    }
}

/// `review.getBranchDiff`.
struct RemoteBranchDiff: Decodable, Equatable, Sendable {
    let branchMarkdown: String
    let currentMarkdown: String
}
