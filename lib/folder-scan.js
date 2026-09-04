import { extractDriveFileIdFromUrl, isGoogleDriveUrl } from "./url-utils.js";
import { normalizeRegularDriveFile } from "./drive-file-download.js";

export const FOLDER_SCAN_STATUSES = Object.freeze({
    IDLE: "idle",
    DISCOVERING: "discovering",
    COLLECTING: "collecting",
    DOWNLOADING: "downloading",
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

export const FOLDER_DOWNLOAD_STATUSES = Object.freeze({
    PENDING: "pending",
    PREPARING: "preparing",
    DOWNLOADING: "downloading",
    COMPLETE: "complete",
    FAILED: "failed",
    CANCELLED: "cancelled",
    SKIPPED: "skipped",
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
        authuser: "0",
        folderName: null,
        downloadDirectory: null,
        total: 0,
        currentIndex: 0,
        currentFileId: null,
        currentFileName: null,
        discoveredCount: 0,
        discoveredVideoCount: 0,
        discoveredRegularFileCount: 0,
        discoveredUnsupportedCount: 0,
        capturedCount: 0,
        failedCount: 0,
        candidates: [],
        regularFiles: [],
        unsupportedFiles: [],
        downloadItems: [],
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
    const regularFiles = dedupeRegularDriveFiles(value.regularFiles);
    const unsupportedFiles = dedupeUnsupportedDriveFiles(value.unsupportedFiles);
    const downloadItems = dedupeFolderDownloadItems(value.downloadItems);
    const status = Object.values(FOLDER_SCAN_STATUSES).includes(value.status)
        ? value.status
        : FOLDER_SCAN_STATUSES.IDLE;
    return {
        ...base,
        ...value,
        id: typeof value.id === "string" ? value.id : null,
        status,
        authuser: typeof value.authuser === "string" && /^\d+$/.test(value.authuser)
            ? value.authuser
            : "0",
        candidates,
        folderName: typeof value.folderName === "string" && value.folderName.trim() ? value.folderName.trim() : null,
        downloadDirectory: typeof value.downloadDirectory === "string" && value.downloadDirectory.trim()
            ? value.downloadDirectory.trim()
            : null,
        total: Number.isInteger(value.total) && value.total >= 0 ? value.total : candidates.length,
        currentIndex: Number.isInteger(value.currentIndex) && value.currentIndex >= 0 ? value.currentIndex : 0,
        discoveredCount: Number.isInteger(value.discoveredCount) && value.discoveredCount >= 0
            ? value.discoveredCount
            : candidates.length + regularFiles.length + unsupportedFiles.length,
        discoveredVideoCount: Number.isInteger(value.discoveredVideoCount) && value.discoveredVideoCount >= 0
            ? value.discoveredVideoCount
            : candidates.length,
        discoveredRegularFileCount: Number.isInteger(value.discoveredRegularFileCount) && value.discoveredRegularFileCount >= 0
            ? value.discoveredRegularFileCount
            : regularFiles.length,
        discoveredUnsupportedCount: Number.isInteger(value.discoveredUnsupportedCount) && value.discoveredUnsupportedCount >= 0
            ? value.discoveredUnsupportedCount
            : unsupportedFiles.length,
        capturedCount: candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.CAPTURED).length,
        failedCount: candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.FAILED).length,
        regularFiles,
        unsupportedFiles,
        downloadItems,
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

function normalizeUnsupportedFile(file) {
    const normalized = normalizeRegularDriveFile(file);
    if (!normalized) return null;
    return {
        ...normalized,
        kind: "unsupported",
        error: typeof file.error === "string" && file.error.trim()
            ? file.error.trim()
            : "Google-native documents require export and are not supported by this version.",
    };
}

function dedupeFiles(files, normalizer) {
    if (!Array.isArray(files)) return [];
    const byFileId = new Map();
    for (const file of files) {
        const normalized = normalizer(file);
        if (!normalized || byFileId.has(normalized.fileId)) continue;
        byFileId.set(normalized.fileId, normalized);
    }
    return [...byFileId.values()];
}

export function dedupeRegularDriveFiles(files) {
    return dedupeFiles(files, normalizeRegularDriveFile);
}

export function dedupeUnsupportedDriveFiles(files) {
    return dedupeFiles(files, normalizeUnsupportedFile);
}

export function normalizeFolderDownloadItem(item) {
    if (!item || typeof item !== "object") return null;
    const fileId = typeof item.fileId === "string" ? item.fileId.trim() : "";
    if (!isValidDriveFileId(fileId)) return null;
    const kind = ["video", "file", "unsupported"].includes(item.kind) ? item.kind : "file";
    const status = Object.values(FOLDER_DOWNLOAD_STATUSES).includes(item.status)
        ? item.status
        : item.status === "completed"
        ? FOLDER_DOWNLOAD_STATUSES.COMPLETE
        : item.status === "interrupted"
        ? FOLDER_DOWNLOAD_STATUSES.FAILED
        : FOLDER_DOWNLOAD_STATUSES.PENDING;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `File ${fileId}`;
    const key = typeof item.key === "string" && item.key.trim() ? item.key.trim() : `${kind}:${fileId}`;
    return {
        key,
        fileId,
        name,
        kind,
        videoId: typeof item.videoId === "string" ? item.videoId : null,
        mimeType: typeof item.mimeType === "string" && item.mimeType.trim() ? item.mimeType.trim() : null,
        status,
        downloadId: Number.isInteger(item.downloadId) && item.downloadId >= 0 ? item.downloadId : null,
        totalBytes: Number.isFinite(item.totalBytes) && item.totalBytes >= 0 ? item.totalBytes : null,
        error: typeof item.error === "string" ? item.error : null,
    };
}

export function dedupeFolderDownloadItems(items) {
    if (!Array.isArray(items)) return [];
    const byIdentity = new Map();
    for (const item of items) {
        const normalized = normalizeFolderDownloadItem(item);
        if (!normalized) continue;
        const identity = `${normalized.kind}:${normalized.fileId}`;
        if (byIdentity.has(identity)) continue;
        byIdentity.set(identity, normalized);
    }
    return [...byIdentity.values()];
}

export function createFolderDownloadItems({ candidates = [], regularFiles = [], unsupportedFiles = [] } = {}) {
    const items = [];
    const videoFileIds = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        if (!isValidDriveFileId(candidate?.fileId)) continue;
        videoFileIds.add(candidate.fileId);
        const captured = candidate.status === FOLDER_CANDIDATE_STATUSES.CAPTURED;
        items.push({
            key: `video:${candidate.fileId}`,
            fileId: candidate.fileId,
            name: candidate.name,
            kind: "video",
            videoId: candidate.videoId ?? null,
            mimeType: "video/*",
            status: captured ? FOLDER_DOWNLOAD_STATUSES.PENDING : FOLDER_DOWNLOAD_STATUSES.FAILED,
            downloadId: null,
            totalBytes: null,
            error: captured ? null : candidate.error ?? "Video capture did not complete.",
        });
    }
    for (const file of dedupeRegularDriveFiles(regularFiles)) {
        if (videoFileIds.has(file.fileId)) continue;
        items.push({
            key: `file:${file.fileId}`,
            fileId: file.fileId,
            name: file.name,
            kind: "file",
            videoId: null,
            mimeType: file.mimeType,
            status: FOLDER_DOWNLOAD_STATUSES.PENDING,
            downloadId: null,
            totalBytes: null,
            error: null,
        });
    }
    for (const file of dedupeUnsupportedDriveFiles(unsupportedFiles)) {
        if (videoFileIds.has(file.fileId)) continue;
        items.push({
            key: `unsupported:${file.fileId}`,
            fileId: file.fileId,
            name: file.name,
            kind: "unsupported",
            videoId: null,
            mimeType: file.mimeType,
            status: FOLDER_DOWNLOAD_STATUSES.SKIPPED,
            downloadId: null,
            totalBytes: null,
            error: file.error,
        });
    }
    return dedupeFolderDownloadItems(items);
}

export function updateFolderDownloadItem(items, key, changes) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => item.key === key ? { ...item, ...changes } : item);
}

export function findFolderDownloadByDownloadId(items, downloadId) {
    if (!Array.isArray(items)) return null;
    return items.find((item) => item.downloadId === downloadId) ?? null;
}

export function folderDownloadProgress(scanOrItems) {
    const items = Array.isArray(scanOrItems) ? scanOrItems : scanOrItems?.downloadItems;
    const normalized = Array.isArray(items) ? items : [];
    const count = (status) => normalized.filter((item) => item.status === status).length;
    return {
        total: normalized.length,
        pendingCount: count(FOLDER_DOWNLOAD_STATUSES.PENDING),
        preparingCount: count(FOLDER_DOWNLOAD_STATUSES.PREPARING),
        downloadingCount: count(FOLDER_DOWNLOAD_STATUSES.DOWNLOADING),
        completedCount: count(FOLDER_DOWNLOAD_STATUSES.COMPLETE),
        failedCount: count(FOLDER_DOWNLOAD_STATUSES.FAILED),
        cancelledCount: count(FOLDER_DOWNLOAD_STATUSES.CANCELLED),
        skippedCount: count(FOLDER_DOWNLOAD_STATUSES.SKIPPED),
    };
}

export function getFolderDownloadQueueBatch(items, maxActive = 3) {
    const normalizedItems = Array.isArray(items) ? items : [];
    const activeCount = normalizedItems.filter((item) => [
        FOLDER_DOWNLOAD_STATUSES.PREPARING,
        FOLDER_DOWNLOAD_STATUSES.DOWNLOADING,
    ].includes(item.status)).length;
    const availableSlots = Math.max(0, Math.floor(Number(maxActive) || 0) - activeCount);
    const pendingItems = normalizedItems.filter((item) => item.status === FOLDER_DOWNLOAD_STATUSES.PENDING
        && !Number.isInteger(item.downloadId)
        && item.kind !== "unsupported");
    const prioritizedItems = [
        ...pendingItems.filter((item) => item.kind === "video"),
        ...pendingItems.filter((item) => item.kind === "file"),
    ];
    return {
        activeCount,
        availableSlots,
        items: prioritizedItems.slice(0, availableSlots),
    };
}

function sourceIdsForVideo(video) {
    const sourceMetadata = video?.sourceMetadata ?? {};
    return [
        sourceMetadata.videoId,
        sourceMetadata.driveId,
        sourceMetadata.fileId,
    ].filter((value) => value !== null && value !== undefined).map(String);
}

function stableSourceIdsForVideo(video) {
    const sourceMetadata = video?.sourceMetadata ?? {};
    return [sourceMetadata.driveId, sourceMetadata.fileId]
        .filter((value) => value !== null && value !== undefined)
        .map(String);
}

export function candidateMatchesVideo(candidate, video, playbackFileId = null) {
    if (!candidate || !isValidDriveFileId(candidate.fileId)) return false;
    const expectedId = String(candidate.fileId);
    const requestId = typeof playbackFileId === "string" ? playbackFileId.trim() : "";
    const sourceIds = sourceIdsForVideo(video);
    const stableSourceIds = stableSourceIdsForVideo(video);

    // Stable response IDs identify the file more reliably than a URL
    // parameter. A videoId may be a playback/session ID, so the request ID
    // remains authoritative when no stable file ID is present.
    if (stableSourceIds.length > 0) return stableSourceIds.includes(expectedId);
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
