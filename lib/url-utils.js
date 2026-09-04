const DRIVE_PLAYBACK_HOSTS = new Set([
    "workspacevideo-pa.clients6.google.com",
    "content-workspacevideo-pa.googleapis.com",
]);

const DRIVE_HOST = "drive.google.com";

function isPlausibleDriveId(value) {
    return typeof value === "string"
        && value.length >= 3
        && value.length <= 512
        && /^[A-Za-z0-9_-]+$/.test(value)
        && !/^\d+$/.test(value);
}

function pathSegments(value) {
    if (typeof value !== "string" || value.length === 0) return [];
    try {
        return new URL(value).pathname.split("/").filter(Boolean);
    } catch {
        return [];
    }
}

function extractIdAfterSegment(value, segment) {
    const segments = pathSegments(value);
    const index = segments.indexOf(segment);
    if (index < 0 || !segments[index + 1]) return null;
    try {
        return decodeURIComponent(segments[index + 1]);
    } catch {
        return null;
    }
}

export function isGoogleDriveUrl(value) {
    if (typeof value !== "string" || value.length === 0) return false;

    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === DRIVE_HOST;
    } catch {
        return false;
    }
}

export function extractDriveFolderId(value) {
    if (!isGoogleDriveUrl(value)) return null;
    const folderId = extractIdAfterSegment(value, "folders");
    return isPlausibleDriveId(folderId) ? folderId : null;
}

export function isGoogleDriveFolderUrl(value) {
    return Boolean(extractDriveFolderId(value));
}

export function extractDriveAuthUser(value) {
    if (!isGoogleDriveUrl(value)) return "0";

    try {
        const url = new URL(value);
        const queryAuthuser = url.searchParams.get("authuser");
        if (queryAuthuser && /^\d+$/.test(queryAuthuser)) return queryAuthuser;

        const segments = url.pathname.split("/").filter(Boolean);
        const driveIndex = segments.indexOf("drive");
        if (driveIndex >= 0 && segments[driveIndex + 1] === "u" && /^\d+$/.test(segments[driveIndex + 2] ?? "")) {
            return segments[driveIndex + 2];
        }
    } catch {
        return "0";
    }
    return "0";
}

export function extractDriveFileIdFromUrl(value) {
    if (!isGoogleDriveUrl(value)) return null;
    if (extractDriveFolderId(value)) return null;
    const pathId = extractIdAfterSegment(value, "d");
    if (isPlausibleDriveId(pathId)) return pathId;

    try {
        const url = new URL(value);
        const queryId = url.searchParams.get("id");
        return isPlausibleDriveId(queryId) ? queryId : null;
    } catch {
        return null;
    }
}

export function extractDrivePlaybackFileId(value) {
    if (!isPotentialDrivePlaybackRequest(value)) return null;

    try {
        const url = new URL(value);
        const segments = url.pathname.split("/").filter(Boolean);
        const mediaIndex = segments.indexOf("media");
        if (
            mediaIndex > 0
            && segments[mediaIndex - 1] === "drive"
            && segments[mediaIndex + 1]
            && segments[mediaIndex + 2] === "playback"
        ) {
            const fileId = decodeURIComponent(segments[mediaIndex + 1]);
            if (isPlausibleDriveId(fileId)) return fileId;
        }

        for (const key of ["fileId", "file_id", "driveId", "drive_id", "videoId", "video_id"]) {
            const id = url.searchParams.get(key);
            if (isPlausibleDriveId(id)) return id;
        }

        for (const marker of ["files", "file", "videos", "video"]) {
            const index = segments.indexOf(marker);
            if (index >= 0 && segments[index + 1]) {
                const id = decodeURIComponent(segments[index + 1]);
                if (isPlausibleDriveId(id)) return id;
            }
        }
    } catch {
        return null;
    }
    return null;
}

export function isPotentialDrivePlaybackRequest(value) {
    if (typeof value !== "string" || value.length === 0) return false;

    try {
        const url = new URL(value);
        return url.protocol === "https:" && DRIVE_PLAYBACK_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
}

export function shouldAttachDebugger(tab, enabled) {
    return Boolean(enabled && tab?.active === true && isGoogleDriveUrl(tab?.url));
}

export function stableUrlPath(value) {
    if (typeof value !== "string" || value.length === 0) return null;

    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    } catch {
        return null;
    }
}

export { DRIVE_PLAYBACK_HOSTS };
