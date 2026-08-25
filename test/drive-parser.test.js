import test from "node:test";
import assert from "node:assert/strict";
import { parseDriveVideoResponse } from "../lib/drive-parser.js";

const progressive = (itag, height) => ({
    itag,
    url: `https://example.test/video/${itag}?token=fake`,
    width: height === 1080 ? 1920 : 1280,
    height,
    fps: 30,
    contentLength: "12345",
    mimeType: "video/mp4",
});

test("parses multiple progressive formats without retaining raw response data", () => {
    const result = parseDriveVideoResponse({
        mediaMetadata: { title: "Fixture video", videoId: "fixture-id" },
        mediaStreamingData: {
            formatStreamingData: {
                progressiveTranscodes: [progressive(22, 720), progressive(37, 1080)],
            },
        },
    });

    assert.equal(result.title, "Fixture video");
    assert.equal(result.formats.length, 2);
    assert.equal(result.formats[0].progressive, true);
    assert.equal(result.formats[0].contentLength, 12345);
    assert.equal(result.sourceMetadata.videoId, "fixture-id");
    assert.equal(Object.hasOwn(result, "rawBody"), false);
});

test("recognizes adaptive formats but marks them as non-progressive", () => {
    const result = parseDriveVideoResponse({
        mediaStreamingData: {
            formatStreamingData: {
                adaptiveTranscodes: [{ itag: 137, url: "https://example.test/adaptive", height: 1080 }],
            },
        },
    });
    assert.equal(result.title, "Untitled video");
    assert.equal(result.formats[0].progressive, false);
});

test("returns null for unexpected, incomplete or non-video responses", () => {
    assert.equal(parseDriveVideoResponse(null), null);
    assert.equal(parseDriveVideoResponse("not an object"), null);
    assert.equal(parseDriveVideoResponse({ mediaMetadata: { title: "No stream" } }), null);
    assert.equal(parseDriveVideoResponse({
        mediaStreamingData: { formatStreamingData: { progressiveTranscodes: [] } },
    }), null);
    assert.doesNotThrow(() => parseDriveVideoResponse({ mediaStreamingData: null }));
});
