import test from "node:test";
import assert from "node:assert/strict";
import {
    buildDriveDownloadPreparationUrl,
    buildRelativeDownloadPath,
    normalizeRegularDriveFile,
    parseDriveDownloadPreparationResponse,
    sanitizeDriveFilename,
    sanitizePathSegment,
    validateDriveDownloadUrl,
} from "../lib/drive-file-download.js";

test("preserves generic filenames without inventing a video extension", () => {
    for (const filename of ["guide.pdf", "archive.zip", "photo.jpg", "spreadsheet.xlsx", "README"]) {
        assert.equal(sanitizeDriveFilename(filename), filename);
        assert.equal(sanitizeDriveFilename(filename).endsWith(".mp4"), false);
    }
});

test("builds safe relative paths for folder and file names", () => {
    const path = buildRelativeDownloadPath("Curso: Meta Ads?", "guía:final?.pdf");
    assert.equal(path, "Curso- Meta Ads-/guía-final-.pdf");
    assert.equal(buildRelativeDownloadPath("../evil", "../../file.pdf").split("/").length, 2);
    assert.equal(buildRelativeDownloadPath("C:\\absolute", "/tmp/file.txt").startsWith("/"), false);
    assert.equal(sanitizePathSegment("."), "file");
    assert.equal(sanitizePathSegment(".."), "file");
});

test("protects Windows reserved path names", () => {
    for (const value of ["CON", "NUL", "COM1", "LPT1"]) {
        assert.notEqual(sanitizePathSegment(value).toUpperCase(), value);
        assert.notEqual(sanitizeDriveFilename(value).toUpperCase(), value);
    }
});

test("builds the authenticated Drive preparation URL", () => {
    const url = new URL(buildDriveDownloadPreparationUrl("ABC", "1"));
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "drive.usercontent.google.com");
    assert.equal(url.pathname, "/uc");
    assert.equal(url.searchParams.get("id"), "ABC");
    assert.equal(url.searchParams.get("authuser"), "1");
    assert.equal(url.searchParams.get("export"), "download");
    assert.equal(buildDriveDownloadPreparationUrl("row-10", "1"), null);
});

test("parses and validates Drive's anti-XSSI download preparation response", () => {
    const result = parseDriveDownloadPreparationResponse(
        ")]}'\n{\"scanResult\":\"OK\",\"disposition\":\"SCAN_CLEAN\",\"fileName\":\"guide.pdf\",\"sizeBytes\":123,\"downloadUrl\":\"https://drive.usercontent.google.com/download?id=ABC&confirm=t\"}",
    );
    assert.deepEqual(result, {
        downloadUrl: "https://drive.usercontent.google.com/download?id=ABC&confirm=t",
        fileName: "guide.pdf",
        sizeBytes: 123,
        scanResult: "OK",
        disposition: "SCAN_CLEAN",
    });
});

test("rejects malformed or unsafe preparation responses", () => {
    assert.equal(parseDriveDownloadPreparationResponse("not json"), null);
    assert.equal(parseDriveDownloadPreparationResponse('{"fileName":"guide.pdf"}'), null);
    assert.equal(parseDriveDownloadPreparationResponse('{"downloadUrl":"http://drive.usercontent.google.com/download"}'), null);
    assert.equal(parseDriveDownloadPreparationResponse('{"downloadUrl":"https://example.test/download"}'), null);
    assert.equal(validateDriveDownloadUrl("https://drive.usercontent.google.com/download?id=ABC") !== null, true);
    assert.equal(validateDriveDownloadUrl("https://drive.usercontent.google.com.evil.test/download"), null);
});

test("normalizes regular Drive files without mixing them with video records", () => {
    assert.deepEqual(normalizeRegularDriveFile({
        fileId: "ABC",
        name: "README",
        mimeType: "text/plain",
    }), {
        fileId: "ABC",
        name: "README",
        mimeType: "text/plain",
        url: "https://drive.google.com/file/d/ABC/view",
        kind: "file",
    });
    assert.equal(normalizeRegularDriveFile({ fileId: "FOLDER", type: "folder" }), null);
    assert.equal(normalizeRegularDriveFile({
        fileId: "FOLDER",
        mimeType: "application/vnd.google-apps.folder",
    }), null);
});
