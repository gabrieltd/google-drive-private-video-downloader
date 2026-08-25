import test from "node:test";
import assert from "node:assert/strict";
import { parseDriveVideoResponse } from "../lib/drive-parser.js";
import { selectBestProgressiveFormat } from "../lib/video-model.js";

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

test("parses realistic transcodeMetadata fields and selects the best quality", () => {
    const result = parseDriveVideoResponse({
        mediaMetadata: { title: "Test video", videoId: "drive-video-id" },
        mediaStreamingData: {
            formatStreamingData: {
                progressiveTranscodes: [
                    {
                        itag: 22,
                        url: "https://example.test/video/22?token=fake",
                        transcodeMetadata: {
                            width: 1280,
                            height: 720,
                            videoFps: 30,
                            contentLength: "100000000",
                            mimeType: "video/mp4",
                            videoCodecString: "avc1.test",
                            audioCodecString: "mp4a.test",
                        },
                    },
                    {
                        itag: 37,
                        url: "https://example.test/video/37?token=fake",
                        transcodeMetadata: {
                            width: 1920,
                            height: 1080,
                            videoFps: 30,
                            contentLength: "200000000",
                            mimeType: "video/mp4",
                        },
                    },
                ],
            },
        },
    });

    assert.equal(result.formats.length, 2);
    assert.equal(result.formats[0].height, 720);
    assert.equal(result.formats[0].fps, 30);
    assert.equal(result.formats[0].contentLength, 100000000);
    assert.equal(result.formats[0].videoCodec, "avc1.test");
    assert.equal(result.formats[0].audioCodec, "mp4a.test");
    assert.equal(result.formats[1].height, 1080);
    assert.equal(selectBestProgressiveFormat(result.formats).height, 1080);
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
