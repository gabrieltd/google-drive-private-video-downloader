import test from "node:test";
import assert from "node:assert/strict";
import {
    extractDriveFileIdFromUrl,
    extractDriveFolderId,
    extractDrivePlaybackFileId,
    isGoogleDriveUrl,
    isGoogleDriveFolderUrl,
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

test("distinguishes Drive folders from file pages", () => {
    assert.equal(extractDriveFolderId("https://drive.google.com/drive/folders/ABC"), "ABC");
    assert.equal(extractDriveFolderId("https://drive.google.com/drive/u/0/folders/ABC"), "ABC");
    assert.equal(isGoogleDriveFolderUrl("https://drive.google.com/drive/folders/ABC"), true);
    assert.equal(isGoogleDriveFolderUrl("https://drive.google.com/file/d/XYZ/view"), false);
    assert.equal(extractDriveFolderId("https://drive.google.com/file/d/XYZ/view"), null);
});

test("extracts Drive file and playback IDs only from supported URL shapes", () => {
    assert.equal(extractDriveFileIdFromUrl("https://drive.google.com/file/d/XYZ/view"), "XYZ");
    assert.equal(extractDriveFileIdFromUrl("https://drive.google.com/open?id=XYZ"), "XYZ");
    assert.equal(extractDriveFileIdFromUrl("https://drive.google.com/drive/folders/ABC?id=ABC"), null);
    assert.equal(
        extractDrivePlaybackFileId("https://workspacevideo-pa.clients6.google.com/v1/drive/media?file_id=XYZ"),
        "XYZ",
    );
    assert.equal(
        extractDrivePlaybackFileId("https://content-workspacevideo-pa.googleapis.com/v1/videos/XYZ"),
        "XYZ",
    );
    assert.equal(extractDrivePlaybackFileId("https://workspacevideo-pa.clients6.google.com/v1/unknown"), null);
});

test("extracts the real Drive playback file ID from both supported hosts", () => {
    assert.equal(
        extractDrivePlaybackFileId(
            "https://workspacevideo-pa.clients6.google.com/v1/drive/media/XYZ/playback?auditContext=forDisplay",
        ),
        "XYZ",
    );
    assert.equal(
        extractDrivePlaybackFileId(
            "https://content-workspacevideo-pa.googleapis.com/v1/drive/media/XYZ/playback",
        ),
        "XYZ",
    );
});

test("ignores playback query parameters when extracting the real path ID", () => {
    assert.equal(
        extractDrivePlaybackFileId(
            "https://workspacevideo-pa.clients6.google.com/v1/drive/media/XYZ/playback?auditContext=forDisplay&key=test&%24unique=value",
        ),
        "XYZ",
    );
});

test("rejects incomplete or incorrectly shaped Drive playback paths", () => {
    assert.equal(
        extractDrivePlaybackFileId("https://workspacevideo-pa.clients6.google.com/v1/drive/media/XYZ"),
        null,
    );
    assert.equal(
        extractDrivePlaybackFileId("https://workspacevideo-pa.clients6.google.com/v1/media/XYZ/playback"),
        null,
    );
    assert.equal(
        extractDrivePlaybackFileId("https://workspacevideo-pa.clients6.google.com/v1/drive/media/"),
        null,
    );
});
