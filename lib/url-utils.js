const DRIVE_PLAYBACK_HOSTS = new Set([
    "workspacevideo-pa.clients6.google.com",
    "content-workspacevideo-pa.googleapis.com",
]);

export function isGoogleDriveUrl(value) {
    if (typeof value !== "string" || value.length === 0) return false;

    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "drive.google.com";
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
