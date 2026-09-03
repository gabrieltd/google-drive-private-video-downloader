const DRIVE_PLAYBACK_HOSTS = new Set([
    "workspacevideo-pa.clients6.google.com",
    "content-workspacevideo-pa.googleapis.com",
]);

const DRIVE_HOST = "drive.google.com";
const DRIVE_MEDIA_HOST_PATTERN = /^[a-z0-9-]+\.c\.drive\.google\.com$/i;

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
        for (const key of ["fileId", "file_id", "driveId", "drive_id", "videoId", "video_id"]) {
            const id = url.searchParams.get(key);
            if (isPlausibleDriveId(id)) return id;
        }

        const segments = url.pathname.split("/").filter(Boolean);
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

export function isPotentialDriveMediaRequest(value) {
    if (typeof value !== "string" || value.length === 0) return false;

    try {
        const url = new URL(value);
        return url.protocol === "https:"
            && DRIVE_MEDIA_HOST_PATTERN.test(url.hostname)
            && url.pathname === "/videoplayback";
    } catch {
        return false;
    }
}

export function extractDriveMediaFileId(value) {
    if (!isPotentialDriveMediaRequest(value)) return null;

    try {
        const url = new URL(value);
        const fileId = url.searchParams.get("driveid") ?? url.searchParams.get("driveId");
        return isPlausibleDriveId(fileId) ? fileId : null;
    } catch {
        return null;
    }
}

export function isDriveAudioMediaRequest(value) {
    if (!isPotentialDriveMediaRequest(value)) return false;

    try {
        const url = new URL(value);
        return /^audio\//i.test(url.searchParams.get("mime") ?? "");
    } catch {
        return false;
    }
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
