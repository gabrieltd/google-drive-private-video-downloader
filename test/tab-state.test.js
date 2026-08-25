import test from "node:test";
import assert from "node:assert/strict";
import { createTabStateManager } from "../lib/tab-state.js";

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
