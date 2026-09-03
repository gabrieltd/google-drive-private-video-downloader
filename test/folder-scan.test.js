import test from "node:test";
import assert from "node:assert/strict";
import {
    FOLDER_CANDIDATE_STATUSES,
    FOLDER_SCAN_STATUSES,
    candidateMatchesVideo,
    createFolderScanState,
    dedupeFolderCandidates,
    folderScanProgress,
    getNextPendingCandidate,
    isLikelyVideoFilename,
    isValidDriveFileId,
    normalizeFolderCandidate,
    retryFailedFolderCandidates,
    updateFolderCandidate,
} from "../lib/folder-scan.js";

test("recognizes common video filenames without including documents or images", () => {
    assert.equal(isLikelyVideoFilename("video.mp4"), true);
    assert.equal(isLikelyVideoFilename("video.MP4"), true);
    assert.equal(isLikelyVideoFilename("course.webm"), true);
    assert.equal(isLikelyVideoFilename("movie.mkv"), true);
    assert.equal(isLikelyVideoFilename("notes.pdf"), false);
    assert.equal(isLikelyVideoFilename("photo.jpg"), false);
    assert.equal(isLikelyVideoFilename("folder-name"), false);
});

test("validates stable-looking Drive IDs and rejects obvious DOM IDs", () => {
    assert.equal(isValidDriveFileId("AAA"), true);
    assert.equal(isValidDriveFileId("1"), false);
    assert.equal(isValidDriveFileId("row-10"), false);
    assert.equal(isValidDriveFileId("menu-item"), false);
    assert.equal(isValidDriveFileId("with spaces"), false);
});

test("normalizes and deduplicates candidates by file ID", () => {
    const candidates = dedupeFolderCandidates([
        { fileId: "AAA", name: "A.mp4", url: "https://drive.google.com/file/d/AAA/view" },
        { fileId: "BBB", name: "B.webm" },
        { fileId: "AAA", name: "A duplicate.mp4" },
        { fileId: "row-10", name: "Fake.mp4" },
        { fileId: "FOLDER", name: "Folder", type: "folder" },
    ]);

    assert.deepEqual(candidates.map((candidate) => candidate.fileId), ["AAA", "BBB"]);
    assert.equal(candidates[1].url, "https://drive.google.com/file/d/BBB/view");
    assert.equal(normalizeFolderCandidate({ fileId: "AAA", isFolder: true }), null);
    assert.equal(normalizeFolderCandidate({ fileId: "CCC", name: "notes.pdf" }), null);
    assert.equal(normalizeFolderCandidate({ fileId: "DDD", name: "Untitled", isVideo: true }).name, "Untitled");
});

test("matches playback only by a stable candidate or source ID", () => {
    const candidate = { fileId: "AAA" };
    assert.equal(candidateMatchesVideo(candidate, { sourceMetadata: { videoId: "AAA" } }), true);
    assert.equal(candidateMatchesVideo(candidate, { sourceMetadata: { videoId: "BBB" } }, "AAA"), true);
    assert.equal(candidateMatchesVideo(candidate, { sourceMetadata: { videoId: "BBB" } }, "BBB"), false);
    assert.equal(candidateMatchesVideo(candidate, { sourceMetadata: { videoId: "AAA" } }, "BBB"), true);
    assert.equal(candidateMatchesVideo(candidate, { sourceMetadata: {} }), false);
});

test("matches the current candidate from the playback URL when response IDs are empty", () => {
    const video = {
        sourceMetadata: {
            fileId: null,
            driveId: null,
            videoId: null,
        },
    };

    assert.equal(candidateMatchesVideo({ fileId: "XYZ" }, video, "XYZ"), true);
    assert.equal(candidateMatchesVideo({ fileId: "AAA" }, video, "BBB"), false);
});

test("prefers a matching response source ID over a different playback URL ID", () => {
    const candidate = { fileId: "AAA" };
    assert.equal(candidateMatchesVideo(
        candidate,
        { sourceMetadata: { videoId: "session-id", driveId: "AAA" } },
        "session-id",
    ), true);
    assert.equal(candidateMatchesVideo(
        candidate,
        { sourceMetadata: { videoId: "BBB", fileId: "BBB" } },
        "session-id",
    ), false);
});

test("does not match a prefetched playback response for another Drive file", () => {
    assert.equal(candidateMatchesVideo(
        { fileId: "AAA" },
        { sourceMetadata: { fileId: "BBB" } },
        "BBB",
    ), false);
});

test("failed candidates can be retried while captured candidates remain unchanged", () => {
    const candidates = [
        { fileId: "AAA", name: "A.mp4", status: FOLDER_CANDIDATE_STATUSES.CAPTURED },
        { fileId: "BBB", name: "B.mp4", status: FOLDER_CANDIDATE_STATUSES.FAILED, error: "timeout" },
        { fileId: "CCC", name: "C.mp4", status: FOLDER_CANDIDATE_STATUSES.CAPTURED },
    ];
    const retried = retryFailedFolderCandidates(candidates);
    assert.deepEqual(retried.map((candidate) => candidate.status), ["captured", "pending", "captured"]);
    assert.equal(retried[1].error, null);
    assert.equal(getNextPendingCandidate(retried).fileId, "BBB");
});

test("progress and candidate transitions support timeout and cancellation semantics", () => {
    const scan = createFolderScanState({ now: 1, status: FOLDER_SCAN_STATUSES.COLLECTING });
    const candidates = [
        { fileId: "AAA", name: "A.mp4", status: FOLDER_CANDIDATE_STATUSES.PROCESSING },
        { fileId: "BBB", name: "B.mp4", status: FOLDER_CANDIDATE_STATUSES.PENDING },
    ];
    const failed = updateFolderCandidate(candidates, "AAA", {
        status: FOLDER_CANDIDATE_STATUSES.FAILED,
        error: "Playback stream was not detected before timeout.",
    });
    assert.equal(folderScanProgress({ ...scan, candidates: failed }).failedCount, 1);
    assert.equal(getNextPendingCandidate(failed).fileId, "BBB");
    const cancelled = failed.map((candidate) => candidate.status === "processing"
        ? { ...candidate, status: "pending" }
        : candidate);
    assert.equal(cancelled[1].status, "pending");
});
