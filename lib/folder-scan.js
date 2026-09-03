import { extractDriveFileIdFromUrl, isGoogleDriveUrl } from "./url-utils.js";

export const FOLDER_SCAN_STATUSES = Object.freeze({
    IDLE: "idle",
    DISCOVERING: "discovering",
    COLLECTING: "collecting",
    PAUSED: "paused",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
    ERROR: "error",
});

export const FOLDER_CANDIDATE_STATUSES = Object.freeze({
    PENDING: "pending",
    PROCESSING: "processing",
    CAPTURED: "captured",
    FAILED: "failed",
});

const VIDEO_EXTENSIONS = new Set([
    "mp4",
    "m4v",
    "mov",
    "webm",
    "mkv",
    "avi",
    "wmv",
    "mpg",
    "mpeg",
    "3gp",
    "mts",
    "m2ts",
]);

const RESERVED_ID_PREFIXES = /^(?:row|menu|item)[-_]/i;

export function isValidDriveFileId(value) {
    if (typeof value !== "string") return false;
    const id = value.trim();
    if (id.length < 3 || id.length > 512) return false;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
    if (/^\d+$/.test(id) || RESERVED_ID_PREFIXES.test(id)) return false;
    return true;
}

export function isLikelyVideoFilename(value) {
    if (typeof value !== "string") return false;
    const name = value.trim();
    const match = name.match(/\.([a-z0-9]{2,8})$/i);
    return Boolean(match && VIDEO_EXTENSIONS.has(match[1].toLowerCase()));
}

export function isVideoCandidateMetadata(metadata = {}) {
    if (!metadata || typeof metadata !== "object") return false;
    const type = String(metadata.type ?? metadata.mimeType ?? "").toLowerCase();
    const label = String(metadata.ariaLabel ?? metadata.ariaLabelText ?? "").toLowerCase();
    return type.startsWith("video/") || type === "video" || /\bvideo\b/.test(label);
}

function canonicalFileUrl(fileId) {
    return `https://drive.google.com/file/d/${fileId}/view`;
}

export function normalizeFolderCandidate(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    if (candidate.isFolder === true || String(candidate.type ?? "").toLowerCase() === "folder") return null;

    const fileId = typeof candidate.fileId === "string" ? candidate.fileId.trim() : "";
    if (!isValidDriveFileId(fileId)) return null;

    const url = typeof candidate.url === "string" && isGoogleDriveUrl(candidate.url)
        && extractDriveFileIdFromUrl(candidate.url) === fileId
        ? candidate.url
        : canonicalFileUrl(fileId);
    const name = typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : `Video ${fileId}`;
    const hasVideoMetadata = candidate.isVideo === true
        || isVideoCandidateMetadata({
            type: candidate.type ?? candidate.mimeType,
            ariaLabel: candidate.ariaLabel,
        });
    if (!isLikelyVideoFilename(name) && !hasVideoMetadata) return null;
    const status = Object.values(FOLDER_CANDIDATE_STATUSES).includes(candidate.status)
        ? candidate.status
        : FOLDER_CANDIDATE_STATUSES.PENDING;

    return {
        fileId,
        name,
        url,
        isVideo: true,
        status,
        attempts: Number.isInteger(candidate.attempts) && candidate.attempts >= 0 ? candidate.attempts : 0,
        startedAt: Number.isFinite(candidate.startedAt) ? candidate.startedAt : null,
        videoId: typeof candidate.videoId === "string" ? candidate.videoId : null,
        error: typeof candidate.error === "string" ? candidate.error : null,
    };
}

export function dedupeFolderCandidates(candidates) {
    if (!Array.isArray(candidates)) return [];
    const byFileId = new Map();
    for (const candidate of candidates) {
        const normalized = normalizeFolderCandidate(candidate);
        if (!normalized || byFileId.has(normalized.fileId)) continue;
        byFileId.set(normalized.fileId, normalized);
    }
    return [...byFileId.values()];
}

export function createFolderScanState({ now = Date.now(), ...overrides } = {}) {
    return {
        id: null,
        status: FOLDER_SCAN_STATUSES.IDLE,
        folderId: null,
        folderUrl: null,
        returnUrl: null,
        total: 0,
        currentIndex: 0,
        currentFileId: null,
        currentFileName: null,
        discoveredCount: 0,
        capturedCount: 0,
        failedCount: 0,
        candidates: [],
        pauseReason: null,
        deadlineAt: null,
        startedAt: null,
        updatedAt: now,
        error: null,
        ...overrides,
    };
}

export function normalizeFolderScanState(value) {
    const base = createFolderScanState();
    if (!value || typeof value !== "object") return base;
    const candidates = dedupeFolderCandidates(value.candidates);
    const status = Object.values(FOLDER_SCAN_STATUSES).includes(value.status)
        ? value.status
        : FOLDER_SCAN_STATUSES.IDLE;
    return {
        ...base,
        ...value,
        id: typeof value.id === "string" ? value.id : null,
        status,
        candidates,
        total: Number.isInteger(value.total) && value.total >= 0 ? value.total : candidates.length,
        currentIndex: Number.isInteger(value.currentIndex) && value.currentIndex >= 0 ? value.currentIndex : 0,
        discoveredCount: Number.isInteger(value.discoveredCount) && value.discoveredCount >= 0
            ? value.discoveredCount
            : candidates.length,
        capturedCount: candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.CAPTURED).length,
        failedCount: candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.FAILED).length,
        deadlineAt: Number.isFinite(value.deadlineAt) ? value.deadlineAt : null,
        startedAt: Number.isFinite(value.startedAt) ? value.startedAt : null,
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    };
}

export function getNextPendingCandidate(candidates) {
    if (!Array.isArray(candidates)) return null;
    return candidates.find((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.PENDING) ?? null;
}

export function updateFolderCandidate(candidates, fileId, changes) {
    if (!Array.isArray(candidates)) return [];
    return candidates.map((candidate) => candidate.fileId === fileId
        ? { ...candidate, ...changes }
        : candidate);
}

export function retryFailedFolderCandidates(candidates) {
    if (!Array.isArray(candidates)) return [];
    return candidates.map((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.FAILED
        ? { ...candidate, status: FOLDER_CANDIDATE_STATUSES.PENDING, error: null }
        : candidate);
}

function sourceIdsForVideo(video) {
    const sourceMetadata = video?.sourceMetadata ?? {};
    return [
        sourceMetadata.videoId,
        sourceMetadata.driveId,
        sourceMetadata.fileId,
    ].filter((value) => value !== null && value !== undefined).map(String);
}

export function candidateMatchesVideo(candidate, video, playbackFileId = null) {
    if (!candidate || !isValidDriveFileId(candidate.fileId)) return false;
    const expectedId = String(candidate.fileId);
    const requestId = typeof playbackFileId === "string" ? playbackFileId.trim() : "";
    const sourceIds = sourceIdsForVideo(video);

    // The response metadata identifies the file more reliably than a URL
    // parameter, which may be a playback/session ID. A conflicting request
    // ID is still rejected when the response has no matching source ID.
    return sourceIds.includes(expectedId) || requestId === expectedId;
}

export function folderScanProgress(scan) {
    const candidates = Array.isArray(scan?.candidates) ? scan.candidates : [];
    return {
        total: candidates.length,
        capturedCount: candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.CAPTURED).length,
        failedCount: candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.FAILED).length,
        pendingCount: candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.PENDING).length,
        processingCount: candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.PROCESSING).length,
    };
}

export { VIDEO_EXTENSIONS };
