import Foundation
import RectoHistory
import RectoSync
import Testing
@testable import Recto

@Suite("Review models")
@MainActor
struct ReviewModelTests {
    private let commentsJSON = #"""
    [
      {"_id":"c1","authorUserId":"u1","authorName":"Ada","anchor":{"quote":"second","prefix":"The ","suffix":" line","offsetHint":4},"body":"Tighten","resolved":false,"createdAt":1},
      {"_id":"c2","authorUserId":"u2","authorName":"Bo","anchor":{"quote":"second","prefix":"The ","suffix":" line","offsetHint":4},"body":"Agreed","threadParentId":"c1","resolved":false,"createdAt":2},
      {"_id":"c3","authorUserId":"u1","authorName":"Ada","anchor":{"quote":"gone text","prefix":"","suffix":"","offsetHint":0},"body":"Lost","resolved":false,"createdAt":3},
      {"_id":"c4","authorUserId":"u1","authorName":"Ada","anchor":{"quote":"line","prefix":"second ","suffix":".","offsetHint":11},"body":"Done","resolved":true,"createdAt":4}
    ]
    """#

    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<100 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }

    @Test("threads group replies; lost and resolved comments draw no highlight")
    func commentsThreadAndLocate() async throws {
        let api = ScriptedAPI()
        await api.respond(ConvexFunction.reviewListComments, json: commentsJSON)
        let comments = CommentsModel()
        comments.follow(CloudDocumentContext(api: api, convexId: "doc1"))
        try await waitUntil { comments.comments.count == 4 }

        #expect(comments.threads.map(\.id) == ["c1", "c3", "c4"])
        #expect(comments.threads.first?.replies.map(\.id) == ["c2"])
        comments.relocate(in: "The second line.")
        #expect(comments.located["c1"] == NSRange(location: 4, length: 6))
        #expect(comments.located["c3"] == nil, "anchor lost")
        #expect(comments.marks.map(\.id).sorted() == ["c1", "c2"], "open, located comments only")
    }

    @Test("a comment is posted with its anchor; a reply with its thread")
    func postAndReply() async throws {
        let api = ScriptedAPI()
        await api.respond(ConvexFunction.reviewListComments, json: commentsJSON)
        let comments = CommentsModel()
        comments.follow(CloudDocumentContext(api: api, convexId: "doc1"))
        try await waitUntil { !comments.comments.isEmpty }

        let text = "The second line."
        comments.startDraft(markdown: text, selection: NSRange(location: 4, length: 6))
        comments.draft?.body = "Why second?"
        await comments.post()
        #expect(comments.draft == nil)
        let add = try #require(await api.calls(to: ConvexFunction.reviewAddComment).first)
        #expect(add.args["documentId"] == "doc1")
        #expect(add.args["body"] == "Why second?")
        #expect(add.args["anchor"] == ["quote": "second", "prefix": "The ", "suffix": " line.", "offsetHint": 4])
        #expect(add.args["threadParentId"] == nil)

        let root = try #require(comments.comments.first)
        #expect(await comments.reply(to: root, body: "Fair"))
        let reply = try #require(await api.calls(to: ConvexFunction.reviewAddComment).last)
        #expect(reply.args["threadParentId"] == "c1")

        await comments.setResolved(root, true)
        #expect(await api.calls(to: ConvexFunction.reviewSetCommentResolved).first?.args["resolved"] == true)
    }

    @Test("an empty selection on whitespace asks for a selection instead of anchoring nothing")
    func emptySelection() {
        let comments = CommentsModel()
        comments.startDraft(markdown: "a   b", selection: NSRange(location: 2, length: 0))
        #expect(comments.draft == nil)
        #expect(comments.errorMessage != nil)
    }

    @Test("accept sends the whole branch, or only the kept changes when reviewing each")
    func acceptWholeOrSome() async throws {
        let api = ScriptedAPI()
        await api.respond(ConvexFunction.reviewListOpenBranches, json: #"[{"_id":"b1","reviewerName":"Ada","nodeCount":2,"updatedAt":5}]"#)
        await api.respond(ConvexFunction.reviewGetBranchDiff, json: #"{"branchMarkdown":"One two. Three four.","currentMarkdown":"One 2. Three 4."}"#)
        let review = ReviewSurfaceModel()
        review.follow(CloudDocumentContext(api: api, convexId: "doc1"))
        try await waitUntil { !review.branches.isEmpty }

        let branch = try #require(review.branches.first)
        await review.select(branch, granularity: .word)
        let hunks = review.hunks(granularity: .word)
        #expect(hunks.count == 2)
        #expect(review.accepted == Set(hunks.map(\.index)), "every change starts accepted")

        await review.accept(granularity: .word)
        #expect(await api.calls(to: ConvexFunction.reviewAcceptBranch).count == 1)

        await review.select(branch, granularity: .word)
        review.perHunk = true
        review.toggle(hunks[0].index)
        await review.accept(granularity: .word)
        let partial = try #require(await api.calls(to: ConvexFunction.reviewAcceptHunks).first)
        #expect(partial.args["acceptedHunks"] == [.number(Double(hunks[1].index))])
        #expect(partial.args["granularity"] == "word")

        await review.select(branch, granularity: .word)
        await review.reject()
        #expect(await api.calls(to: ConvexFunction.reviewRejectBranch).count == 1)
    }
}
