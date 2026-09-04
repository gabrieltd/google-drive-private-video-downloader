const DRIVE_DOWNLOAD_HOST = "drive.usercontent.google.com";
const MAX_PATH_SEGMENT_LENGTH = 180;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const RESERVED_ID_PREFIXES = /^(?:row|menu|item)[-_]/i;

function isPlausibleDriveFileId(value) {
    return typeof value === "string"
        && /^[A-Za-z0-9_-]{3,512}$/.test(value.trim())
        && !/^\d+$/.test(value.trim())
        && !RESERVED_ID_PREFIXES.test(value.trim());
}

function trimTrailingDotsAndSpaces(value) {
    return value.replace(/[. ]+$/g, "");
}

export function sanitizePathSegment(value, fallback = "file") {
    const source = typeof value === "string" ? value : "";
    let segment = source
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .trim();

    if (!segment || segment === "." || segment === "..") segment = fallback;
    segment = trimTrailingDotsAndSpaces(segment) || fallback;
    if (RESERVED_WINDOWS_NAMES.test(segment)) segment = `${segment}-`;

    segment = segment.slice(0, MAX_PATH_SEGMENT_LENGTH);
    segment = trimTrailingDotsAndSpaces(segment);
    return segment || "file";
}

export function sanitizeDriveFilename(value, fallback = "file") {
    return sanitizePathSegment(value, fallback);
}

export function buildRelativeDownloadPath(folderName, filename) {
    const safeFolderName = sanitizePathSegment(folderName, "Google Drive Folder");
    const safeFilename = sanitizeDriveFilename(filename, "file");
    return `${safeFolderName}/${safeFilename}`;
}

export function buildDriveDownloadPreparationUrl(fileId, authuser = "0") {
    const normalizedFileId = typeof fileId === "string" ? fileId.trim() : "";
    if (!isPlausibleDriveFileId(normalizedFileId)) return null;

    const normalizedAuthuser = typeof authuser === "string" && /^\d+$/.test(authuser)
        ? authuser
        : "0";
    const url = new URL(`https://${DRIVE_DOWNLOAD_HOST}/uc`);
    url.searchParams.set("id", normalizedFileId);
    url.searchParams.set("authuser", normalizedAuthuser);
    url.searchParams.set("export", "download");
    return url.toString();
}

export function validateDriveDownloadUrl(value) {
    if (typeof value !== "string" || value.length === 0) return null;

    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.hostname !== DRIVE_DOWNLOAD_HOST) return null;
        return url.toString();
    } catch {
        return null;
    }
}

export function parseDriveDownloadPreparationResponse(text) {
    if (typeof text !== "string" || text.length === 0) return null;

    try {
        const cleanText = text.replace(/^\)\]\}'\s*/, "");
        const data = JSON.parse(cleanText);
        if (!data || typeof data !== "object" || Array.isArray(data)) return null;

        const downloadUrl = validateDriveDownloadUrl(data.downloadUrl);
        if (!downloadUrl) return null;

        return {
            downloadUrl,
            fileName: typeof data.fileName === "string" && data.fileName.trim() ? data.fileName.trim() : null,
            sizeBytes: Number.isFinite(Number(data.sizeBytes)) ? Number(data.sizeBytes) : null,
            scanResult: typeof data.scanResult === "string" ? data.scanResult : null,
            disposition: typeof data.disposition === "string" ? data.disposition : null,
        };
    } catch {
        return null;
    }
}

export function normalizeRegularDriveFile(file) {
    if (!file || typeof file !== "object") return null;
    const fileId = typeof file.fileId === "string" ? file.fileId.trim() : "";
    if (!isPlausibleDriveFileId(fileId)) return null;
    const rawMimeType = typeof file.mimeType === "string" ? file.mimeType.trim().toLowerCase() : "";
    if (file.isFolder === true
        || String(file.type ?? "").toLowerCase() === "folder"
        || rawMimeType === "application/vnd.google-apps.folder") return null;

    const name = typeof file.name === "string" && file.name.trim() ? file.name.trim() : `File ${fileId}`;
    const mimeType = rawMimeType
        ? rawMimeType
        : "application/octet-stream";
    return {
        fileId,
        name,
        mimeType,
        url: `https://drive.google.com/file/d/${fileId}/view`,
        kind: "file",
    };
}

export function isGoogleNativeMimeType(mimeType) {
    return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("application/vnd.google-apps.");
}

export { DRIVE_DOWNLOAD_HOST };
