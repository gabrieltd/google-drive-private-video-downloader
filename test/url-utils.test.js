import test from "node:test";
import assert from "node:assert/strict";
import {
    isGoogleDriveUrl,
    isPotentialDrivePlaybackRequest,
    shouldAttachDebugger,
} from "../lib/url-utils.js";

test("validates Drive URLs without substring false positives", () => {
    assert.equal(isGoogleDriveUrl("https://drive.google.com/file/d/fake/view"), true);
    assert.equal(isGoogleDriveUrl("http://drive.google.com/file/d/fake/view"), false);
    assert.equal(isGoogleDriveUrl("https://drive.google.com.evil.example/"), false);
    assert.equal(isGoogleDriveUrl("not a URL"), false);
});

test("allows only known HTTPS Drive playback hosts", () => {
    assert.equal(isPotentialDrivePlaybackRequest("https://workspacevideo-pa.clients6.google.com/v1/fake"), true);
    assert.equal(isPotentialDrivePlaybackRequest("https://content-workspacevideo-pa.googleapis.com/v1/fake"), true);
    assert.equal(isPotentialDrivePlaybackRequest("https://example.google.com/video"), false);
    assert.equal(isPotentialDrivePlaybackRequest("https://workspacevideo-pa.clients6.google.com.evil.example/"), false);
});

test("debugger policy requires an enabled active Drive tab", () => {
    assert.equal(shouldAttachDebugger({ active: true, url: "https://drive.google.com/file/fake" }, true), true);
    assert.equal(shouldAttachDebugger({ active: false, url: "https://drive.google.com/file/fake" }, true), false);
    assert.equal(shouldAttachDebugger({ active: true, url: "https://drive.google.com/file/fake" }, false), false);
    assert.equal(shouldAttachDebugger({ active: true, url: "https://chatgpt.com/" }, true), false);
});
