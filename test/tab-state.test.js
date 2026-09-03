import test from "node:test";
import assert from "node:assert/strict";
import { createTabStateManager } from "../lib/tab-state.js";
import { FOLDER_CANDIDATE_STATUSES, FOLDER_SCAN_STATUSES } from "../lib/folder-scan.js";

test("tab state is independent and hydrates without debugger handles", async () => {
    let stored = {};
    const storage = {
        async get(key) { return { [key]: stored[key] }; },
        async set(value) { stored = { ...stored, ...value }; },
    };
    const manager = createTabStateManager({ storage });
    manager.enableTab(100);
    manager.enableTab(101);
    manager.setDebuggerAttached(100, true);
    manager.addOrUpdateVideo(100, {
        id: "video-1",
        tabId: 100,
        title: "Video",
        capturedAt: 1,
        formats: [{ itag: 22, url: "https://example.test/video", progressive: true }],
        sourceMetadata: { videoId: "one" },
        identityKey: "source:one",
        download: null,
    });
    await manager.persist();

    const restored = createTabStateManager({ storage });
    await restored.hydrate();
    assert.equal(restored.isTabEnabled(100), true);
    assert.equal(restored.isTabEnabled(101), true);
    assert.equal(restored.getState(100).debuggerAttached, false);
    assert.equal(restored.getVideosForTab(101).length, 0);

    restored.removeTab(100);
    assert.equal(restored.isTabEnabled(100), false);
    assert.equal(restored.isTabEnabled(101), true);
});

test("deduplicates the same video while merging newly discovered formats", () => {
    const manager = createTabStateManager();
    manager.enableTab(7);
    const base = {
        tabId: 7,
        title: "Same video",
        capturedAt: 1,
        sourceMetadata: { videoId: "same-video" },
        identityKey: "source:same-video",
        download: null,
    };
    const first = manager.addOrUpdateVideo(7, {
        ...base,
        id: "video-same",
        formats: [{ itag: 22, url: "https://example.test/video?itag=22", height: 720, progressive: true }],
    });
    const second = manager.addOrUpdateVideo(7, {
        ...base,
        id: "video-same",
        formats: [
            { itag: 22, url: "https://example.test/video?itag=22", height: 720, progressive: true },
            { itag: 37, url: "https://example.test/video?itag=37", height: 1080, progressive: true },
        ],
    });
    assert.equal(first.isNew, true);
    assert.equal(second.isNew, false);
    assert.equal(manager.getVideosForTab(7).length, 1);
    assert.equal(manager.getVideosForTab(7)[0].formats.length, 2);
});

test("new detections replace stale signed URLs for the same format", () => {
    const manager = createTabStateManager();
    manager.enableTab(8);
    const base = {
        id: "video-refresh",
        tabId: 8,
        title: "Refresh video",
        capturedAt: 1,
        sourceMetadata: { videoId: "refresh-id" },
        identityKey: "source:refresh-id",
        download: null,
    };

    manager.addOrUpdateVideo(8, {
        ...base,
        formats: [{ itag: 37, url: "https://example.test/video?token=old", progressive: true }],
    });
    manager.addOrUpdateVideo(8, {
        ...base,
        formats: [{ itag: 37, url: "https://example.test/video?token=new", progressive: true }],
    });

    const videos = manager.getVideosForTab(8);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].formats.length, 1);
    assert.equal(videos[0].formats[0].url, "https://example.test/video?token=new");
});

test("download associations survive persist and service-worker hydration", async () => {
    let stored = {};
    const storage = {
        async get(key) { return { [key]: stored[key] }; },
        async set(value) { stored = { ...stored, ...value }; },
    };
    const manager = createTabStateManager({ storage });
    manager.enableTab(9);
    manager.addOrUpdateVideo(9, {
        id: "video-download-recovery",
        tabId: 9,
        title: "Download recovery",
        capturedAt: 1,
        formats: [{ itag: 22, url: "https://example.test/video", progressive: true }],
        sourceMetadata: { videoId: "download-recovery" },
        identityKey: "source:download-recovery",
        download: null,
    });
    manager.updateDownload(9, "video-download-recovery", {
        downloadId: 321,
        status: "downloading",
    });
    await manager.persist();

    const restored = createTabStateManager({ storage });
    await restored.hydrate();
    assert.deepEqual(restored.findVideoByDownloadId(321), {
        tabId: 9,
        videoId: "video-download-recovery",
        video: restored.getVideosForTab(9)[0],
    });
});

function videoFixture(id, title = id) {
    return {
        id,
        tabId: 20,
        title,
        capturedAt: 1,
        formats: [{ itag: 22, url: `https://example.test/${id}`, progressive: true }],
        sourceMetadata: { videoId: id },
        identityKey: `source:${id}`,
        download: null,
    };
}

test("collector accumulates videos and selects new videos by default", () => {
    const manager = createTabStateManager();
    manager.enableTab(20);
    manager.addOrUpdateVideo(20, videoFixture("video-a"));
    manager.addOrUpdateVideo(20, videoFixture("video-b"));
    manager.addOrUpdateVideo(20, videoFixture("video-c"));

    assert.equal(manager.getVideosForTab(20).length, 3);
    assert.deepEqual(manager.getSelectedVideoIds(20), ["video-a", "video-b", "video-c"]);
});

test("video updates preserve an intentional deselection", () => {
    const manager = createTabStateManager();
    manager.enableTab(20);
    manager.addOrUpdateVideo(20, videoFixture("video-a"));
    manager.addOrUpdateVideo(20, videoFixture("video-b"));
    manager.setSelectedVideoIds(20, ["video-b"]);

    manager.addOrUpdateVideo(20, {
        ...videoFixture("video-a"),
        formats: [{ itag: 22, url: "https://example.test/video-a?token=fresh", progressive: true }],
    });

    assert.deepEqual(manager.getSelectedVideoIds(20), ["video-b"]);
    assert.equal(manager.getVideosForTab(20)[0].formats[0].url, "https://example.test/video-a?token=fresh");
});

test("selection is validated, persisted, and restored independently from videos", async () => {
    let stored = {};
    const storage = {
        async get(key) { return { [key]: stored[key] }; },
        async set(value) { stored = { ...stored, ...value }; },
    };
    const manager = createTabStateManager({ storage });
    manager.enableTab(20);
    manager.addOrUpdateVideo(20, videoFixture("video-a"));
    manager.addOrUpdateVideo(20, videoFixture("video-b"));
    manager.setSelectedVideoIds(20, ["video-a", "fake-id"]);
    await manager.persist();

    const restored = createTabStateManager({ storage });
    await restored.hydrate();
    assert.deepEqual(restored.getSelectedVideoIds(20), ["video-a"]);
});

test("download selection only returns videos belonging to the tab", () => {
    const manager = createTabStateManager();
    manager.enableTab(20);
    manager.addOrUpdateVideo(20, videoFixture("video-a"));
    manager.addOrUpdateVideo(20, videoFixture("video-b"));

    assert.deepEqual(
        manager.getVideosByIds(20, ["video-a", "fake-video-id"]).map((video) => video.id),
        ["video-a"],
    );
});

test("clear list removes videos and selection without disabling capture", () => {
    const manager = createTabStateManager();
    manager.enableTab(20);
    manager.addOrUpdateVideo(20, videoFixture("video-a"));
    manager.setSelectedVideoIds(20, []);
    manager.clearTabVideos(20);

    assert.equal(manager.getState(20).enabled, true);
    assert.deepEqual(manager.getVideosForTab(20), []);
    assert.deepEqual(manager.getSelectedVideoIds(20), []);
});

test("turning capture off preserves collection and selection", () => {
    const manager = createTabStateManager();
    manager.enableTab(20);
    manager.addOrUpdateVideo(20, videoFixture("video-a"));
    manager.addOrUpdateVideo(20, videoFixture("video-b"));
    manager.setSelectedVideoIds(20, ["video-a"]);
    manager.disableTab(20);

    assert.equal(manager.getState(20).enabled, false);
    assert.equal(manager.getVideosForTab(20).length, 2);
    assert.deepEqual(manager.getSelectedVideoIds(20), ["video-a"]);
});

test("persists folder scan progress independently from captured videos", async () => {
    let stored = {};
    const storage = {
        async get(key) { return { [key]: stored[key] }; },
        async set(value) { stored = { ...stored, ...value }; },
    };
    const manager = createTabStateManager({ storage });
    manager.enableTab(30);
    manager.addOrUpdateVideo(30, videoFixture("video-a"));
    manager.setSelectedVideoIds(30, []);
    manager.updateFolderScan(30, {
        id: "scan-1",
        status: FOLDER_SCAN_STATUSES.COLLECTING,
        folderId: "FOLDER",
        total: 2,
        capturedCount: 1,
        candidates: [
            { fileId: "AAA", name: "A.mp4", status: FOLDER_CANDIDATE_STATUSES.CAPTURED },
            { fileId: "BBB", name: "B.mp4", status: FOLDER_CANDIDATE_STATUSES.PROCESSING },
        ],
        currentFileId: "BBB",
    });
    await manager.persist();

    const restored = createTabStateManager({ storage });
    await restored.hydrate();
    const state = restored.getState(30);
    assert.equal(state.folderScan.status, FOLDER_SCAN_STATUSES.COLLECTING);
    assert.equal(state.folderScan.currentFileId, "BBB");
    assert.equal(state.videos.length, 1);
    assert.deepEqual(state.selectedVideoIds, []);
});

test("resetting the folder scan does not require a separate collection reset", () => {
    const manager = createTabStateManager();
    manager.enableTab(31);
    manager.addOrUpdateVideo(31, videoFixture("video-a"));
    manager.updateFolderScan(31, { id: "scan-2", status: FOLDER_SCAN_STATUSES.COMPLETED });
    manager.resetFolderScan(31);
    assert.equal(manager.getState(31).folderScan.status, FOLDER_SCAN_STATUSES.IDLE);
    assert.equal(manager.getVideosForTab(31).length, 1);
});
