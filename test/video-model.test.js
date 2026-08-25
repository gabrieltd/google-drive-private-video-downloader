import test from "node:test";
import assert from "node:assert/strict";
import {
    createVideoRecord,
    sanitizeFilename,
    selectBestProgressiveFormat,
} from "../lib/video-model.js";

test("sanitizeFilename creates safe bounded MP4 names", () => {
    assert.equal(sanitizeFilename("video"), "video.mp4");
    assert.equal(sanitizeFilename("video.mp4"), "video.mp4");
    assert.equal(sanitizeFilename("my:video?.mp4"), "my-video-.mp4");
    assert.equal(sanitizeFilename("CON"), "CON-.mp4");
    assert.equal(sanitizeFilename("video."), "video.mp4");
    assert.equal(sanitizeFilename("video     "), "video.mp4");
    assert.ok(sanitizeFilename("x".repeat(500)).length <= 180);
});

test("selectBestProgressiveFormat prefers resolution, then width and fps", () => {
    const best = selectBestProgressiveFormat([
        { progressive: true, height: 480, width: 854, fps: 30 },
        { progressive: true, height: 1080, width: 1920, fps: 30 },
        { progressive: true, height: 720, width: 1280, fps: 60 },
    ]);
    assert.equal(best.height, 1080);

    const highFps = selectBestProgressiveFormat([
        { progressive: true, height: 1080, width: 1920, fps: 30 },
        { progressive: true, height: 1080, width: 1920, fps: 60 },
    ]);
    assert.equal(highFps.fps, 60);
});

test("selectBestProgressiveFormat ignores adaptive and handles missing values", () => {
    assert.equal(selectBestProgressiveFormat(null), null);
    assert.equal(selectBestProgressiveFormat([]), null);
    const best = selectBestProgressiveFormat([
        { progressive: false, height: 2160, width: 3840 },
        { progressive: true, height: 720 },
        { progressive: true, height: 720, width: 1920 },
    ]);
    assert.equal(best.width, 1920);
});

test("video records have deterministic identities and merge-friendly metadata", () => {
    const first = createVideoRecord({
        title: "Demo",
        formats: [{ itag: 22, url: "https://example.test/video?id=one", progressive: true }],
        sourceMetadata: { videoId: "drive-file-1", stableSourceKey: "source:drive-file-1" },
    }, 10);
    const second = createVideoRecord({
        title: "Demo",
        formats: [{ itag: 37, url: "https://example.test/video?id=two", progressive: true }],
        sourceMetadata: { videoId: "drive-file-1", stableSourceKey: "source:drive-file-1" },
    }, 10);
    assert.equal(first.id, second.id);
});
