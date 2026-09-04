import { enrichParsedVideoSource, parseDriveVideoResponse } from "../lib/drive-parser.js";
import { MESSAGE_TYPES } from "../lib/messages.js";
import { createTabStateManager } from "../lib/tab-state.js";
import {
    FOLDER_CANDIDATE_STATUSES,
    FOLDER_DOWNLOAD_STATUSES,
    FOLDER_SCAN_STATUSES,
    candidateMatchesVideo,
    createFolderDownloadItems,
    createFolderScanState,
    dedupeRegularDriveFiles,
    dedupeUnsupportedDriveFiles,
    dedupeFolderCandidates,
    folderDownloadProgress,
    getFolderDownloadQueueBatch,
    getNextPendingCandidate,
    normalizeFolderCandidate,
    updateFolderDownloadItem,
    retryFailedFolderCandidates,
    updateFolderCandidate,
} from "../lib/folder-scan.js";
import {
    createVideoRecord,
    formatIdentity,
    sanitizeFilename,
    selectBestProgressiveFormat,
} from "../lib/video-model.js";
import {
    buildDriveDownloadPreparationUrl,
    buildRelativeDownloadPath,
    parseDriveDownloadPreparationResponse,
    sanitizePathSegment,
    validateDriveDownloadUrl,
} from "../lib/drive-file-download.js";
import {
    extractDriveAuthUser,
    isGoogleDriveUrl,
    extractDriveFileIdFromUrl,
    extractDriveFolderId,
    extractDrivePlaybackFileId,
    isGoogleDriveFolderUrl,
    extractDriveFolderNameFromTitle,
    resolveDriveFolderName,
    isPotentialDrivePlaybackRequest,
    shouldAttachDebugger,
} from "../lib/url-utils.js";

const DEBUG = false;
const SESSION_STORAGE_KEY = "tabStates";
const REATTACH_COOLDOWN_MS = 5000;
const REQUEST_EXPIRY_MS = 60_000;
const EXTERNAL_DEBUGGER_REASONS = new Set(["replaced_with_devtools", "canceled_by_user"]);

const captureOperations = new Map();
const pendingRequests = new Map();
const downloadById = new Map();
const folderDownloadById = new Map();
const folderDownloadPumpOperations = new Map();
const cleanupTabs = new Set();
const expectedDetachTabs = new Set();
const expectedDetachTimers = new Map();
const lastDetachAt = new Map();
const folderScanRuntime = new Map();
const expectedFolderNavigations = new Map();
const FOLDER_CANDIDATE_TIMEOUT_MS = 20_000;
const MAX_ACTIVE_FOLDER_DOWNLOADS = 3;
const ACTIVE_FOLDER_SCAN_STATUSES = new Set([
    FOLDER_SCAN_STATUSES.DISCOVERING,
    FOLDER_SCAN_STATUSES.COLLECTING,
    FOLDER_SCAN_STATUSES.DOWNLOADING,
    FOLDER_SCAN_STATUSES.PAUSED,
]);
const ACTIVE_FOLDER_CAPTURE_STATUSES = new Set([
    FOLDER_SCAN_STATUSES.DISCOVERING,
    FOLDER_SCAN_STATUSES.COLLECTING,
    FOLDER_SCAN_STATUSES.PAUSED,
]);

function debugLog(...args) {
    if (DEBUG) console.debug("[Drive Video Downloader]", ...args);
}

function chromeCall(method, ...args) {
    return new Promise((resolve, reject) => {
        method(...args, (...callbackArgs) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
                reject(new Error(lastError.message));
                return;
            }
            resolve(callbackArgs.length <= 1 ? callbackArgs[0] : callbackArgs);
        });
    });
}

const sessionStorage = {
    get: (key) => chromeCall(chrome.storage.session.get.bind(chrome.storage.session), key),
    set: (value) => chromeCall(chrome.storage.session.set.bind(chrome.storage.session), value),
};
const tabState = createTabStateManager({ storage: sessionStorage, storageKey: SESSION_STORAGE_KEY });

function stateFor(tabId) {
    return tabState.getState(tabId);
}

function operationForTab(tabId, operation) {
    const previous = captureOperations.get(tabId) ?? Promise.resolve();
    const current = previous
        .catch(() => undefined)
        .then(operation)
        .finally(() => {
            if (captureOperations.get(tabId) === current) captureOperations.delete(tabId);
        });
    captureOperations.set(tabId, current);
    return current;
}

function removePendingRequests(tabId) {
    for (const [key, request] of pendingRequests.entries()) {
        if (request.tabId === tabId) pendingRequests.delete(key);
    }
}

function removeExpiredRequests(tabId) {
    const now = Date.now();
    for (const [key, request] of pendingRequests.entries()) {
        if (request.tabId === tabId && now - request.createdAt > REQUEST_EXPIRY_MS) pendingRequests.delete(key);
    }
}

function requestKey(tabId, requestId) {
    return `${tabId}:${requestId}`;
}

function markExpectedDetach(tabId) {
    expectedDetachTabs.add(tabId);
    const previousTimer = expectedDetachTimers.get(tabId);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
        expectedDetachTabs.delete(tabId);
        expectedDetachTimers.delete(tabId);
    }, 1000);
    expectedDetachTimers.set(tabId, timer);
}

function clearExpectedDetach(tabId) {
    expectedDetachTabs.delete(tabId);
    const timer = expectedDetachTimers.get(tabId);
    if (timer) clearTimeout(timer);
    expectedDetachTimers.delete(tabId);
}

function sendRuntimeEvent(message) {
    try {
        chrome.runtime.sendMessage(message, () => {
            void chrome.runtime.lastError;
        });
    } catch (error) {
        debugLog("No popup listener", error.message);
    }
}

function setBadge(tabId, text) {
    return chromeCall(chrome.action.setBadgeText.bind(chrome.action), { tabId, text }).catch((error) => {
        debugLog("Unable to update badge", error.message);
    });
}

async function updateBadge(tabId) {
    const count = tabState.getVideosForTab(tabId).length;
    await setBadge(tabId, count > 0 ? String(count) : "");
}

function notifyTabState(tabId) {
    sendRuntimeEvent({ type: MESSAGE_TYPES.TAB_STATE_CHANGED, tabId, state: stateFor(tabId) });
}

function notifyVideoChange(tabId, type, video) {
    sendRuntimeEvent({
        type,
        tabId,
        video,
        state: stateFor(tabId),
    });
}

function notifyDownload(tabId, video) {
    sendRuntimeEvent({
        type: MESSAGE_TYPES.DOWNLOAD_UPDATED,
        tabId,
        videoId: video.id,
        download: video.download,
    });
}

function isExpectedDetachError(error) {
    return /not attached|no target with given id|target.*closed|detached/i.test(error?.message ?? "");
}

function userFacingAttachError(error) {
    if (/another debugger|already attached|debugger is already attached/i.test(error?.message ?? "")) {
        return "Unable to attach debugger. Another debugging session may already be using this tab.";
    }
    return `Unable to attach debugger. ${error?.message ?? "Chrome rejected the debugger connection."}`;
}

function userFacingDownloadError(error) {
    return `Download failed. ${error?.message ?? "The captured download URL may have expired. Reload the Drive video and try again."}`;
}

function normalizeDownloadState(state) {
    return state === "in_progress" ? "downloading" : state;
}

function formatDownloadChangeError(errorCode) {
    return `Download failed (${errorCode}). The captured download URL may have expired. Reload the Drive video and try again.`;
}

async function runWithConcurrency(tasks, concurrency = 3) {
    const results = new Array(tasks.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), tasks.length);

    async function worker() {
        while (nextIndex < tasks.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
                results[index] = await tasks[index]();
            } catch (error) {
                results[index] = { success: false, error: error.message };
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function createScanId() {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    return `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isActiveFolderScan(scan) {
    return ACTIVE_FOLDER_SCAN_STATUSES.has(scan?.status);
}

function isFolderCaptureActive(scan) {
    return ACTIVE_FOLDER_CAPTURE_STATUSES.has(scan?.status);
}

function folderRuntimeFor(tabId, scanId = null) {
    const runtime = folderScanRuntime.get(tabId);
    return runtime && (!scanId || runtime.scanId === scanId) ? runtime : null;
}

function clearFolderCandidateTimer(tabId) {
    const runtime = folderScanRuntime.get(tabId);
    if (runtime?.candidateTimer) clearTimeout(runtime.candidateTimer);
    if (runtime) runtime.candidateTimer = null;
}

function notifyFolderScan(tabId) {
    const state = stateFor(tabId);
    sendRuntimeEvent({
        type: MESSAGE_TYPES.FOLDER_SCAN_UPDATED,
        tabId,
        folderScan: state.folderScan,
        state,
        videos: state.videos,
    });
}

function notifyStateAndFolderScan(tabId) {
    notifyTabState(tabId);
    notifyFolderScan(tabId);
}

function sendTabMessage(tabId, message) {
    return chromeCall(chrome.tabs.sendMessage.bind(chrome.tabs), tabId, message).catch(() => null);
}

function stopFolderRuntime(tabId, notifyContent = false) {
    const runtime = folderScanRuntime.get(tabId);
    if (runtime) {
        runtime.cancelled = true;
        clearFolderCandidateTimer(tabId);
        if (notifyContent && runtime.scanId) {
            void sendTabMessage(tabId, { type: MESSAGE_TYPES.FOLDER_SCANNER_CANCEL, scanId: runtime.scanId });
        }
    }
    folderScanRuntime.delete(tabId);
    expectedFolderNavigations.delete(tabId);
}

function setExpectedFolderNavigation(tabId, navigation) {
    expectedFolderNavigations.set(tabId, navigation);
}

function expectedNavigationMatches(tabId, url) {
    const expected = expectedFolderNavigations.get(tabId);
    if (!expected) return false;
    if (expected.kind === "candidate") return extractDriveFileIdFromUrl(url) === expected.fileId;
    return extractDriveFolderId(url) === expected.folderId;
}

function clearExpectedFolderNavigation(tabId) {
    expectedFolderNavigations.delete(tabId);
}

function scanErrorMessage(error) {
    if (/active tab|not active/i.test(error?.message ?? "")) return "Keep the Drive folder tab active while scanning.";
    return "Unable to inspect this Drive folder.";
}

function sendFolderScannerCommand(tabId, scanId, type) {
    return sendTabMessage(tabId, { type, scanId });
}

async function persistAndNotifyFolderScan(tabId) {
    await tabState.persist();
    notifyStateAndFolderScan(tabId);
}

async function markFolderScanError(tabId, scanId, error) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || !isActiveFolderScan(scan)) return false;
    clearFolderCandidateTimer(tabId);
    const runtime = folderRuntimeFor(tabId, scanId);
    if (runtime) runtime.cancelled = true;
    clearExpectedFolderNavigation(tabId);
    tabState.updateFolderScan(tabId, {
        status: FOLDER_SCAN_STATUSES.ERROR,
        currentFileId: null,
        currentFileName: null,
        deadlineAt: null,
        error: typeof error === "string" ? error : "Unable to inspect this Drive folder.",
        pauseReason: null,
    });
    await persistAndNotifyFolderScan(tabId);
    return true;
}

function attachDebugger(tabId) {
    return chromeCall(chrome.debugger.attach.bind(chrome.debugger), { tabId }, "1.3").catch((error) => {
        if (/already attached|debugger is already attached/i.test(error.message)) return undefined;
        throw error;
    });
}

function detachDebugger(tabId) {
    return chromeCall(chrome.debugger.detach.bind(chrome.debugger), { tabId });
}

function sendDebuggerCommand(tabId, method, params = {}) {
    return chromeCall(chrome.debugger.sendCommand.bind(chrome.debugger), { tabId }, method, params);
}

async function cleanupTabResourcesInternal(
    tabId,
    { clearVideos = true, removeState = false, detach = true, forceDetach = false } = {},
) {
    cleanupTabs.add(tabId);
    try {
        if (clearVideos || removeState) stopFolderRuntime(tabId, true);
        const state = stateFor(tabId);
        if (detach && (forceDetach || state.debuggerAttached)) {
            try {
                await detachDebugger(tabId);
            } catch (error) {
                if (!isExpectedDetachError(error)) {
                    tabState.setLastError(tabId, `Unable to detach debugger. ${error.message}`);
                    console.error("Unable to detach debugger", error);
                }
            }
        }

        tabState.setDebuggerAttached(tabId, false);
        removePendingRequests(tabId);
        if (clearVideos) tabState.clearTabVideos(tabId);
        if (removeState) tabState.removeTab(tabId);
        await tabState.persist();
        await updateBadge(tabId);
        notifyTabState(tabId);
    } finally {
        cleanupTabs.delete(tabId);
    }
}

export function cleanupTabResources(tabId, options) {
    return operationForTab(tabId, () => cleanupTabResourcesInternal(tabId, options));
}

async function disableCapture(tabId) {
    return operationForTab(tabId, async () => {
        const scan = tabState.getFolderScan(tabId);
        if (isActiveFolderScan(scan)) await cancelFolderScanInternal(tabId, "Folder scan cancelled.", false);
        tabState.disableTab(tabId);
        await cleanupTabResourcesInternal(tabId, {
            clearVideos: false,
            removeState: false,
            forceDetach: true,
        });
        return true;
    });
}

async function leaveDriveInternal(tabId) {
    tabState.disableTab(tabId);
    await cleanupTabResourcesInternal(tabId, {
        clearVideos: true,
        removeState: true,
        forceDetach: true,
    });
    return true;
}

async function leaveDrive(tabId) {
    return operationForTab(tabId, () => leaveDriveInternal(tabId));
}

async function detachInactiveTabInternal(tabId) {
    if (!tabState.isTabEnabled(tabId)) return false;
    const state = stateFor(tabId);
    if (!state.debuggerAttached) return false;

    markExpectedDetach(tabId);
    let detachError = false;
    try {
        await detachDebugger(tabId);
    } catch (error) {
        if (!isExpectedDetachError(error)) {
            detachError = true;
            tabState.setLastError(tabId, `Unable to detach debugger. ${error.message}`);
            console.error("Unable to detach inactive debugger", error);
        }
        clearExpectedDetach(tabId);
    }
    tabState.setDebuggerAttached(tabId, false);
    if (!detachError) tabState.setLastError(tabId, null);
    removePendingRequests(tabId);
    await pauseFolderScan(tabId, "Return to this Drive tab to continue.");
    await tabState.persist();
    notifyStateAndFolderScan(tabId);
    return true;
}

async function detachInactiveTab(tabId) {
    return operationForTab(tabId, () => detachInactiveTabInternal(tabId));
}

async function startCapture(tabId) {
    return operationForTab(tabId, async () => {
        if (!tabState.isTabEnabled(tabId)) return false;

        const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
        if (!isGoogleDriveUrl(tab?.url)) {
            await leaveDriveInternal(tabId);
            return false;
        }
        if (!shouldAttachDebugger(tab, true)) {
            if (stateFor(tabId).debuggerAttached) await detachInactiveTabInternal(tabId);
            return false;
        }

        try {
            if (!stateFor(tabId).debuggerAttached) {
                await attachDebugger(tabId);
                tabState.setDebuggerAttached(tabId, true);
            }
            await sendDebuggerCommand(tabId, "Network.enable");
            tabState.setLastError(tabId, null);
            await tabState.persist();
            notifyTabState(tabId);
            return true;
        } catch (error) {
            tabState.setDebuggerAttached(tabId, false);
            tabState.setLastError(tabId, userFacingAttachError(error));
            await tabState.persist();
            notifyTabState(tabId);
            console.error("Unable to start capture", error);
            return false;
        }
    });
}

async function injectFolderScanner(tabId, scanId) {
    await chromeCall(
        chrome.scripting.executeScript.bind(chrome.scripting),
        { target: { tabId }, files: ["content/folder-scanner.js"] },
    );
    await sendTabMessage(tabId, { type: MESSAGE_TYPES.FOLDER_SCANNER_START, scanId });
}

async function startFolderDiscovery(tabId, scanId) {
    const runtime = folderRuntimeFor(tabId, scanId);
    if (!runtime || runtime.discoveryStarted) return true;
    runtime.discoveryStarted = true;
    try {
        await injectFolderScanner(tabId, scanId);
        return true;
    } catch (error) {
        runtime.discoveryStarted = false;
        throw error;
    }
}

function armFolderCandidateTimer(tabId, scanId, fileId, deadlineAt) {
    clearFolderCandidateTimer(tabId);
    const runtime = folderRuntimeFor(tabId, scanId);
    if (!runtime) return;
    const delay = Math.max(0, deadlineAt - Date.now());
    runtime.candidateTimer = setTimeout(() => {
        void handleFolderCandidateTimeout(tabId, scanId, fileId);
    }, delay);
}

async function completeFolderScan(tabId, scanId) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || scan.status !== FOLDER_SCAN_STATUSES.COLLECTING) return false;
    return startFolderDownloadPhase(tabId, scanId);
}

async function failFolderCandidate(tabId, scanId, fileId, error) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || scan.status !== FOLDER_SCAN_STATUSES.COLLECTING) return false;
    const candidate = scan.candidates.find((item) => item.fileId === fileId);
    if (!candidate || candidate.status !== FOLDER_CANDIDATE_STATUSES.PROCESSING) return false;

    clearFolderCandidateTimer(tabId);
    const index = scan.candidates.findIndex((item) => item.fileId === fileId);
    clearExpectedFolderNavigation(tabId);
    tabState.updateFolderScan(tabId, {
        candidates: updateFolderCandidate(scan.candidates, fileId, {
            status: FOLDER_CANDIDATE_STATUSES.FAILED,
            error: String(error),
        }),
        currentIndex: index + 1,
        currentFileId: null,
        currentFileName: null,
        deadlineAt: null,
    });
    await persistAndNotifyFolderScan(tabId);
    return true;
}

function fetchDriveDownloadInPage(preparationUrl) {
    return globalThis.fetch(preparationUrl, {
        method: "POST",
        credentials: "include",
        cache: "no-cache",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Drive-First-Party": "DriveWebUi",
            "X-Json-Requested": "true",
        },
        body: "",
    }).then(async (response) => ({
        ok: response.ok,
        status: response.status,
        text: await response.text(),
    }));
}

async function prepareRegularDriveFileDownload(tabId, fileId, authuser) {
    const preparationUrl = buildDriveDownloadPreparationUrl(fileId, authuser);
    if (!preparationUrl) throw new Error("Unable to prepare this Drive file for download.");

    const results = await chromeCall(
        chrome.scripting.executeScript.bind(chrome.scripting),
        {
            target: { tabId },
            world: "MAIN",
            func: fetchDriveDownloadInPage,
            args: [preparationUrl],
        },
    );
    const result = results?.[0]?.result;
    if (!result?.ok) throw new Error(`Drive returned HTTP ${result?.status ?? "error"} while preparing the file.`);

    const prepared = parseDriveDownloadPreparationResponse(result.text);
    if (!prepared) throw new Error("Drive did not return a valid download URL.");
    const downloadUrl = validateDriveDownloadUrl(prepared.downloadUrl);
    if (!downloadUrl) throw new Error("Drive returned an invalid download URL.");
    return { ...prepared, downloadUrl };
}

async function updateFolderDownloadItemState(tabId, scanId, key, changes) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || scan.status !== FOLDER_SCAN_STATUSES.DOWNLOADING) return null;
    const item = scan.downloadItems.find((downloadItem) => downloadItem.key === key);
    if (!item) return null;

    const items = updateFolderDownloadItem(scan.downloadItems, key, changes);
    tabState.updateFolderScan(tabId, { downloadItems: items });
    await persistAndNotifyFolderScan(tabId);
    return tabState.getFolderScan(tabId).downloadItems.find((downloadItem) => downloadItem.key === key) ?? null;
}

function folderDownloadFilename(scan, item, fallback = "file") {
    return buildRelativeDownloadPath(scan.downloadDirectory ?? scan.folderName ?? "Google Drive Folder", item.name || fallback);
}

function folderDownloadOptions(scan, item, url, fallback = "file") {
    return {
        url,
        filename: folderDownloadFilename(scan, item, fallback),
        conflictAction: "uniquify",
        saveAs: false,
    };
}

async function startFolderVideoDownload(tabId, scanId, item) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || scan.status !== FOLDER_SCAN_STATUSES.DOWNLOADING) return { success: false, cancelled: true };
    const currentItem = scan.downloadItems.find((downloadItem) => downloadItem.key === item.key);
    if (!currentItem || currentItem.status !== FOLDER_DOWNLOAD_STATUSES.PREPARING) {
        return { success: false, cancelled: true };
    }
    const video = tabState.findVideo(tabId, item.videoId);
    const format = video ? selectBestProgressiveFormat(video.formats) : null;
    if (!format) {
        await updateFolderDownloadItemState(tabId, scanId, item.key, {
            status: FOLDER_DOWNLOAD_STATUSES.FAILED,
            error: "No downloadable progressive stream was found.",
        });
        return { success: false };
    }

    try {
        const downloadId = await chromeCall(
            chrome.downloads.download.bind(chrome.downloads),
            folderDownloadOptions(scan, item, format.url, "video"),
        );
        if (!Number.isInteger(downloadId)) throw new Error("Chrome did not return a download ID.");
        folderDownloadById.set(downloadId, { tabId, scanId, itemKey: item.key });
        const currentScan = tabState.getFolderScan(tabId);
        const currentDownloadItem = currentScan.downloadItems.find((downloadItem) => downloadItem.key === item.key);
        const terminal = [
            FOLDER_DOWNLOAD_STATUSES.COMPLETE,
            FOLDER_DOWNLOAD_STATUSES.FAILED,
            FOLDER_DOWNLOAD_STATUSES.CANCELLED,
        ].includes(currentDownloadItem?.status);
        if (currentDownloadItem?.status === FOLDER_DOWNLOAD_STATUSES.CANCELLED) {
            await chromeCall(chrome.downloads.cancel.bind(chrome.downloads), downloadId).catch(() => undefined);
        }
        await updateFolderDownloadItemState(tabId, scanId, item.key, {
            downloadId,
            totalBytes: format.contentLength,
            ...(terminal ? {} : { status: FOLDER_DOWNLOAD_STATUSES.DOWNLOADING, error: null }),
        });
        return { success: true, downloadId };
    } catch (error) {
        await updateFolderDownloadItemState(tabId, scanId, item.key, {
            status: FOLDER_DOWNLOAD_STATUSES.FAILED,
            error: `Chrome rejected the download. ${error.message}`,
        });
        return { success: false, error: error.message };
    }
}

async function startFolderRegularFileDownload(tabId, scanId, item) {
    const initialScan = tabState.getFolderScan(tabId);
    if (initialScan.id !== scanId || initialScan.status !== FOLDER_SCAN_STATUSES.DOWNLOADING) {
        return { success: false, cancelled: true };
    }
    const currentItem = initialScan.downloadItems.find((downloadItem) => downloadItem.key === item.key);
    if (!currentItem || currentItem.status !== FOLDER_DOWNLOAD_STATUSES.PREPARING) {
        return { success: false, cancelled: true };
    }

    try {
        const prepared = await prepareRegularDriveFileDownload(tabId, item.fileId, initialScan.authuser);
        const currentScan = tabState.getFolderScan(tabId);
        if (currentScan.id !== scanId || currentScan.status !== FOLDER_SCAN_STATUSES.DOWNLOADING) return { success: false, cancelled: true };
        const downloadId = await chromeCall(
            chrome.downloads.download.bind(chrome.downloads),
            folderDownloadOptions(currentScan, item, prepared.downloadUrl, "file"),
        );
        if (!Number.isInteger(downloadId)) throw new Error("Chrome did not return a download ID.");
        folderDownloadById.set(downloadId, { tabId, scanId, itemKey: item.key });
        const latestScan = tabState.getFolderScan(tabId);
        const currentDownloadItem = latestScan.downloadItems.find((downloadItem) => downloadItem.key === item.key);
        const terminal = [
            FOLDER_DOWNLOAD_STATUSES.COMPLETE,
            FOLDER_DOWNLOAD_STATUSES.FAILED,
            FOLDER_DOWNLOAD_STATUSES.CANCELLED,
        ].includes(currentDownloadItem?.status);
        if (currentDownloadItem?.status === FOLDER_DOWNLOAD_STATUSES.CANCELLED) {
            await chromeCall(chrome.downloads.cancel.bind(chrome.downloads), downloadId).catch(() => undefined);
        }
        await updateFolderDownloadItemState(tabId, scanId, item.key, {
            downloadId,
            name: prepared.fileName ?? item.name,
            totalBytes: prepared.sizeBytes,
            ...(terminal ? {} : { status: FOLDER_DOWNLOAD_STATUSES.DOWNLOADING, error: null }),
        });
        return { success: true, downloadId };
    } catch (error) {
        await updateFolderDownloadItemState(tabId, scanId, item.key, {
            status: FOLDER_DOWNLOAD_STATUSES.FAILED,
            error: error.message || "Unable to prepare this Drive file for download.",
        });
        return { success: false, error: error.message };
    }
}

async function returnToFolderAfterCapture(tabId, scanId) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || !scan.returnUrl) return;
    const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
    if (!tab || !isGoogleDriveUrl(tab.url) || tab.url === scan.returnUrl) return;

    setExpectedFolderNavigation(tabId, { kind: "return", scanId, folderId: scan.folderId });
    await chromeCall(chrome.tabs.update.bind(chrome.tabs), tabId, { url: scan.returnUrl }).catch((error) => {
        debugLog("Unable to return to the original Drive folder", error.message);
    });
    clearExpectedFolderNavigation(tabId);
}

async function maybeCompleteFolderDownload(tabId, scanId) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || scan.status !== FOLDER_SCAN_STATUSES.DOWNLOADING) return false;
    const progress = folderDownloadProgress(scan);
    if (progress.pendingCount || progress.preparingCount || progress.downloadingCount) return false;

    tabState.updateFolderScan(tabId, {
        status: FOLDER_SCAN_STATUSES.COMPLETED,
        currentIndex: scan.candidates.length,
        currentFileId: null,
        currentFileName: null,
        deadlineAt: null,
        pauseReason: null,
        error: null,
    });
    await persistAndNotifyFolderScan(tabId);
    folderScanRuntime.delete(tabId);
    await returnToFolderAfterCapture(tabId, scanId);
    return true;
}

async function pumpFolderDownloadQueueInternal(tabId, scanId) {
    while (true) {
        const scan = tabState.getFolderScan(tabId);
        if (scan.id !== scanId || scan.status !== FOLDER_SCAN_STATUSES.DOWNLOADING) return;

        const batch = getFolderDownloadQueueBatch(scan.downloadItems, MAX_ACTIVE_FOLDER_DOWNLOADS);
        if (batch.items.length === 0) return;

        const selectedKeys = new Set(batch.items.map((item) => item.key));
        tabState.updateFolderScan(tabId, {
            downloadItems: scan.downloadItems.map((item) => selectedKeys.has(item.key)
                ? { ...item, status: FOLDER_DOWNLOAD_STATUSES.PREPARING, error: null }
                : item),
        });
        await persistAndNotifyFolderScan(tabId);

        debugLog("Folder download queue", {
            tabId,
            scanId,
            activeFolderDownloads: batch.activeCount,
            availableSlots: batch.availableSlots,
            nextItems: batch.items.map((item) => item.key),
        });

        await Promise.all(batch.items.map((item) => item.kind === "video"
            ? startFolderVideoDownload(tabId, scanId, item)
            : startFolderRegularFileDownload(tabId, scanId, item)));
    }
}

function pumpFolderDownloadQueue(tabId, scanId) {
    const key = `${tabId}:${scanId}`;
    const previous = folderDownloadPumpOperations.get(key) ?? Promise.resolve();
    const current = previous
        .catch(() => undefined)
        .then(() => pumpFolderDownloadQueueInternal(tabId, scanId))
        .finally(() => {
            if (folderDownloadPumpOperations.get(key) === current) folderDownloadPumpOperations.delete(key);
        });
    folderDownloadPumpOperations.set(key, current);
    return current;
}

async function startFolderDownloadPhase(tabId, scanId) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || ![
        FOLDER_SCAN_STATUSES.DISCOVERING,
        FOLDER_SCAN_STATUSES.COLLECTING,
    ].includes(scan.status)) return false;

    clearFolderCandidateTimer(tabId);
    clearExpectedFolderNavigation(tabId);
    const downloadItems = createFolderDownloadItems({
        candidates: scan.candidates,
        regularFiles: scan.regularFiles,
        unsupportedFiles: scan.unsupportedFiles,
    });
    tabState.updateFolderScan(tabId, {
        status: FOLDER_SCAN_STATUSES.DOWNLOADING,
        currentIndex: scan.candidates.length,
        currentFileId: null,
        currentFileName: null,
        deadlineAt: null,
        downloadItems,
        error: null,
        pauseReason: null,
    });
    await persistAndNotifyFolderScan(tabId);

    await pumpFolderDownloadQueue(tabId, scanId);
    await maybeCompleteFolderDownload(tabId, scanId);
    return true;
}

async function handleFolderCandidateTimeout(tabId, scanId, fileId) {
    const failed = await failFolderCandidate(
        tabId,
        scanId,
        fileId,
        "Playback stream was not detected before timeout.",
    );
    if (failed) requestFolderAdvance(tabId, scanId);
}

async function handleFolderVideoCapture(tabId, video, playbackFileId, responseCreatedAt = null) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.status !== FOLDER_SCAN_STATUSES.COLLECTING || !scan.currentFileId) return false;

    const candidate = scan.candidates.find((item) => item.fileId === scan.currentFileId);
    if (!candidate || candidate.status !== FOLDER_CANDIDATE_STATUSES.PROCESSING) return false;
    if (candidate.startedAt && responseCreatedAt && responseCreatedAt < candidate.startedAt) return false;
    if (!candidateMatchesVideo(candidate, video, playbackFileId)) return false;

    const hasProgressive = (video.formats ?? []).some((format) => format.progressive === true);
    const index = scan.candidates.findIndex((item) => item.fileId === candidate.fileId);
    const candidateUpdate = hasProgressive
        ? {
              status: FOLDER_CANDIDATE_STATUSES.CAPTURED,
              videoId: video.id,
              error: null,
          }
        : {
              status: FOLDER_CANDIDATE_STATUSES.FAILED,
              videoId: video.id,
              error: "No directly downloadable progressive stream was found.",
          };

    clearFolderCandidateTimer(tabId);
    tabState.updateFolderScan(tabId, {
        candidates: updateFolderCandidate(scan.candidates, candidate.fileId, candidateUpdate),
        currentIndex: index + 1,
        currentFileId: null,
        currentFileName: null,
        deadlineAt: null,
    });
    await persistAndNotifyFolderScan(tabId);
    requestFolderAdvance(tabId, scan.id);
    return true;
}

async function advanceFolderScan(tabId, scanId) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== scanId || scan.status !== FOLDER_SCAN_STATUSES.COLLECTING) return;
    if (scan.currentFileId) return;

    const candidate = getNextPendingCandidate(scan.candidates);
    if (!candidate) {
        await completeFolderScan(tabId, scanId);
        return;
    }

    const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
    if (!tab || tab.active !== true || !isGoogleDriveUrl(tab.url)) {
        await pauseFolderScan(tabId, "Return to this Drive tab to continue.");
        return;
    }
    const previousCandidate = scan.currentIndex > 0 ? scan.candidates[scan.currentIndex - 1] : null;
    const isPreviousCandidatePage = extractDriveFileIdFromUrl(tab.url) === previousCandidate?.fileId;
    if (extractDriveFolderId(tab.url) !== scan.folderId && !isPreviousCandidatePage) {
        await cancelFolderScanInternal(tabId, "Folder scan stopped because the Drive tab navigation changed.");
        return;
    }

    const index = scan.candidates.findIndex((item) => item.fileId === candidate.fileId);
    const deadlineAt = Date.now() + FOLDER_CANDIDATE_TIMEOUT_MS;
    tabState.updateFolderScan(tabId, {
        candidates: updateFolderCandidate(scan.candidates, candidate.fileId, {
            status: FOLDER_CANDIDATE_STATUSES.PROCESSING,
            attempts: candidate.attempts + 1,
            startedAt: Date.now(),
            error: null,
        }),
        currentIndex: index,
        currentFileId: candidate.fileId,
        currentFileName: candidate.name,
        deadlineAt,
        pauseReason: null,
        error: null,
    });
    removePendingRequests(tabId);
    setExpectedFolderNavigation(tabId, { kind: "candidate", scanId, fileId: candidate.fileId });
    await persistAndNotifyFolderScan(tabId);
    armFolderCandidateTimer(tabId, scanId, candidate.fileId, deadlineAt);

    try {
        const currentFileId = extractDriveFileIdFromUrl(tab.url);
        if (currentFileId === candidate.fileId) {
            await chromeCall(chrome.tabs.reload.bind(chrome.tabs), tabId);
        } else {
            await chromeCall(chrome.tabs.update.bind(chrome.tabs), tabId, { url: candidate.url });
        }
    } catch (error) {
        clearExpectedFolderNavigation(tabId);
        const failed = await failFolderCandidate(tabId, scanId, candidate.fileId, "Unable to open this Drive video.");
        if (failed) debugLog("Folder candidate navigation failed", error.message);
    }
}

function requestFolderAdvance(tabId, scanId) {
    setTimeout(() => void processNextFolderCandidate(tabId, scanId), 0);
}

async function processNextFolderCandidate(tabId, scanId) {
    const runtime = folderRuntimeFor(tabId, scanId);
    if (!runtime || runtime.cancelled || runtime.advancePromise) return;
    runtime.advancePromise = advanceFolderScan(tabId, scanId)
        .catch((error) => markFolderScanError(tabId, scanId, "Unable to continue the folder scan.").catch(() => {
            console.error("Folder scan continuation failed", error);
        }))
        .finally(() => {
            runtime.advancePromise = null;
            const next = tabState.getFolderScan(tabId);
            if (folderRuntimeFor(tabId, scanId) && next.status === FOLDER_SCAN_STATUSES.COLLECTING && !next.currentFileId) {
                requestFolderAdvance(tabId, scanId);
            }
        });
    await runtime.advancePromise;
}

async function pauseFolderScan(tabId, reason) {
    const scan = tabState.getFolderScan(tabId);
    if (!isFolderCaptureActive(scan) || scan.status === FOLDER_SCAN_STATUSES.PAUSED) return false;
    clearFolderCandidateTimer(tabId);
    const runtime = folderRuntimeFor(tabId, scan.id);
    if (runtime) runtime.cancelled = scan.status === FOLDER_SCAN_STATUSES.DISCOVERING;
    if (scan.status === FOLDER_SCAN_STATUSES.DISCOVERING && scan.id) {
        await sendFolderScannerCommand(tabId, scan.id, MESSAGE_TYPES.FOLDER_SCANNER_CANCEL);
        if (runtime) runtime.discoveryStarted = false;
    }
    tabState.updateFolderScan(tabId, {
        status: FOLDER_SCAN_STATUSES.PAUSED,
        pauseReason: reason,
        error: null,
    });
    await persistAndNotifyFolderScan(tabId);
    return true;
}

async function resumeFolderScan(tabId) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.status !== FOLDER_SCAN_STATUSES.PAUSED || !scan.id) return false;
    const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
    if (!tab || tab.active !== true || !isGoogleDriveUrl(tab.url)) return false;

    const previousCandidate = scan.currentIndex > 0 ? scan.candidates[scan.currentIndex - 1] : null;
    const isPreviousCandidatePage = scan.total > 0
        && extractDriveFileIdFromUrl(tab.url) === previousCandidate?.fileId;
    if (!scan.currentFileId && extractDriveFolderId(tab.url) !== scan.folderId && !isPreviousCandidatePage) {
        await cancelFolderScanInternal(tabId, "Folder scan stopped because the Drive tab navigation changed.");
        return false;
    }

    const runtime = folderRuntimeFor(tabId, scan.id) ?? { scanId: scan.id, cancelled: false, candidateTimer: null, advancePromise: null };
    runtime.cancelled = false;
    folderScanRuntime.set(tabId, runtime);

    if (scan.currentFileId) {
        const candidate = scan.candidates.find((item) => item.fileId === scan.currentFileId);
        if (!candidate) return false;
        if (candidate.status !== FOLDER_CANDIDATE_STATUSES.PROCESSING) {
            tabState.updateFolderScan(tabId, {
                candidates: updateFolderCandidate(scan.candidates, candidate.fileId, {
                    status: FOLDER_CANDIDATE_STATUSES.PROCESSING,
                    startedAt: Date.now(),
                    error: null,
                }),
            });
        }
        if (scan.deadlineAt && scan.deadlineAt <= Date.now()) {
            const failed = await failFolderCandidate(tabId, scan.id, candidate.fileId, "Playback stream was not detected before timeout.");
            if (failed) requestFolderAdvance(tabId, scan.id);
            return true;
        }

        const deadlineAt = Date.now() + FOLDER_CANDIDATE_TIMEOUT_MS;
        tabState.updateFolderScan(tabId, { status: FOLDER_SCAN_STATUSES.COLLECTING, pauseReason: null, deadlineAt, error: null });
        await persistAndNotifyFolderScan(tabId);
        armFolderCandidateTimer(tabId, scan.id, candidate.fileId, deadlineAt);
        setExpectedFolderNavigation(tabId, { kind: "candidate", scanId: scan.id, fileId: candidate.fileId });
        const currentFileId = extractDriveFileIdFromUrl(tab.url);
        if (currentFileId === candidate.fileId) {
            await chromeCall(chrome.tabs.reload.bind(chrome.tabs), tabId).catch(() => undefined);
        }
        else await chromeCall(chrome.tabs.update.bind(chrome.tabs), tabId, { url: candidate.url }).catch(() => undefined);
        return true;
    }

    if (scan.total > 0) {
        tabState.updateFolderScan(tabId, { status: FOLDER_SCAN_STATUSES.COLLECTING, pauseReason: null, error: null });
        await persistAndNotifyFolderScan(tabId);
        requestFolderAdvance(tabId, scan.id);
        return true;
    }

    tabState.updateFolderScan(tabId, { status: FOLDER_SCAN_STATUSES.DISCOVERING, pauseReason: null, error: null });
    await persistAndNotifyFolderScan(tabId);
    try {
        await startFolderDiscovery(tabId, scan.id);
    } catch (error) {
        await markFolderScanError(tabId, scan.id, scanErrorMessage(error));
        return false;
    }
    return true;
}

async function cancelFolderScanInternal(tabId, message = "Folder scan cancelled.", persist = true) {
    const scan = tabState.getFolderScan(tabId);
    if (!isActiveFolderScan(scan)) return false;
    const runtime = folderRuntimeFor(tabId, scan.id);
    if (runtime) runtime.cancelled = true;
    clearFolderCandidateTimer(tabId);
    if (scan.status === FOLDER_SCAN_STATUSES.DISCOVERING && scan.id) {
        await sendFolderScannerCommand(tabId, scan.id, MESSAGE_TYPES.FOLDER_SCANNER_CANCEL);
    }
    if (scan.status === FOLDER_SCAN_STATUSES.DOWNLOADING) {
        const activeDownloads = scan.downloadItems.filter((item) => item.status === FOLDER_DOWNLOAD_STATUSES.DOWNLOADING
            && Number.isInteger(item.downloadId));
        await Promise.all(activeDownloads.map((item) => chromeCall(
            chrome.downloads.cancel.bind(chrome.downloads),
            item.downloadId,
        ).catch(() => undefined)));
    }
    const candidates = scan.candidates.map((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.PROCESSING
        ? { ...candidate, status: FOLDER_CANDIDATE_STATUSES.PENDING, error: null }
        : candidate);
    const downloadItems = scan.downloadItems.map((item) => [
        FOLDER_DOWNLOAD_STATUSES.PENDING,
        FOLDER_DOWNLOAD_STATUSES.PREPARING,
        FOLDER_DOWNLOAD_STATUSES.DOWNLOADING,
    ].includes(item.status)
        ? { ...item, status: FOLDER_DOWNLOAD_STATUSES.CANCELLED, error: item.error ?? message }
        : item);
    tabState.updateFolderScan(tabId, {
        status: FOLDER_SCAN_STATUSES.CANCELLED,
        candidates,
        downloadItems,
        currentFileId: null,
        currentFileName: null,
        deadlineAt: null,
        pauseReason: null,
        error: message,
    });
    clearExpectedFolderNavigation(tabId);
    folderScanRuntime.delete(tabId);
    if (persist) await persistAndNotifyFolderScan(tabId);
    return true;
}

function decodeResponseBody(body, base64Encoded) {
    if (!base64Encoded) return body;
    try {
        const binary = atob(body);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

async function processResponse(tabId, requestId, request) {
    return operationForTab(tabId, async () => {
        if (!tabState.isTabEnabled(tabId)) return;

        let result;
        try {
            result = await sendDebuggerCommand(tabId, "Network.getResponseBody", { requestId });
        } catch (error) {
            debugLog("Response body unavailable", error.message);
            return;
        }

        const body = decodeResponseBody(result?.body, result?.base64Encoded);
        if (!body) return;

        let data;
        try {
            data = JSON.parse(body);
        } catch {
            let requestPath = null;
            try {
                const requestUrl = new URL(request.url);
                requestPath = { host: requestUrl.hostname, pathname: requestUrl.pathname };
            } catch {
                requestPath = { host: null, pathname: null };
            }
            debugLog("Ignored non-JSON playback response", requestPath);
            return;
        }

        const playbackFileId = extractDrivePlaybackFileId(request.url);
        const parsedVideo = enrichParsedVideoSource(parseDriveVideoResponse(data), playbackFileId);
        if (!parsedVideo || !tabState.isTabEnabled(tabId)) return;

        const video = createVideoRecord(parsedVideo, tabId);
        const resultForVideo = tabState.addOrUpdateVideo(tabId, video);
        if (resultForVideo.changed) {
            await tabState.persist();
            await updateBadge(tabId);
            notifyVideoChange(
                tabId,
                resultForVideo.isNew ? MESSAGE_TYPES.VIDEO_DETECTED : MESSAGE_TYPES.VIDEO_UPDATED,
                resultForVideo.video,
            );
        }

        const scanBeforeCapture = tabState.getFolderScan(tabId);
        const currentCandidate = scanBeforeCapture.candidates.find(
            (candidate) => candidate.fileId === scanBeforeCapture.currentFileId,
        );
        const matched = currentCandidate
            ? candidateMatchesVideo(currentCandidate, resultForVideo.video, playbackFileId)
            : false;
        const capturedForFolder = await handleFolderVideoCapture(
            tabId,
            resultForVideo.video,
            playbackFileId,
            request.createdAt,
        );
        if (scanBeforeCapture.status === FOLDER_SCAN_STATUSES.COLLECTING) {
            debugLog("Folder playback response", {
                currentCandidateFileId: scanBeforeCapture.currentFileId,
                playbackFileId,
                matched,
                progressiveFormats: resultForVideo.video.formats.filter((format) => format.progressive).length,
                capturedForFolder,
            });
        }
    });
}

async function handleDebuggerEvent(debuggeeId, method, params) {
    const tabId = debuggeeId?.tabId;
    if (!Number.isInteger(tabId) || !tabState.isTabEnabled(tabId)) return;

    if (method === "Network.requestWillBeSent") {
        const url = params?.request?.url;
        if (!isPotentialDrivePlaybackRequest(url)) return;
        removeExpiredRequests(tabId);
        pendingRequests.set(requestKey(tabId, params.requestId), { tabId, url, createdAt: Date.now() });
        return;
    }

    if (method === "Network.responseReceived") {
        const key = requestKey(tabId, params?.requestId);
        const request = pendingRequests.get(key) ?? {
            tabId,
            url: params?.response?.url,
            createdAt: Date.now(),
        };
        pendingRequests.delete(key);
        if (request.url && isPotentialDrivePlaybackRequest(request.url)) {
            await processResponse(tabId, params.requestId, request);
        }
        return;
    }

    if (method === "Network.loadingFailed") pendingRequests.delete(requestKey(tabId, params?.requestId));
}

async function startDownload(tabId, videoId, formatId = null, formatKey = null) {
    const video = tabState.findVideo(tabId, videoId);
    if (!video) return { success: false, error: "Video is no longer available in this tab." };

    const format = formatKey
        ? video.formats.find((item) => item.progressive && formatIdentity(item) === formatKey)
        : formatId === null
        ? selectBestProgressiveFormat(video.formats)
        : video.formats.find((item) => String(item.itag) === String(formatId) && item.progressive);
    if (!format) return { success: false, error: "No downloadable progressive stream was found." };

    let downloadId;
    try {
        downloadId = await chromeCall(
            chrome.downloads.download.bind(chrome.downloads),
            { url: format.url, filename: sanitizeFilename(video.title), conflictAction: "uniquify" },
        );
    } catch (error) {
        const message = userFacingDownloadError(error);
        const failedVideo = tabState.updateDownload(tabId, videoId, { status: "interrupted", error: message });
        if (failedVideo) {
            await tabState.persist();
            notifyDownload(tabId, failedVideo);
        }
        return { success: false, error: message };
    }

    downloadById.set(downloadId, { tabId, videoId });
    const downloadingVideo = tabState.updateDownload(tabId, videoId, {
        downloadId,
        status: "downloading",
        error: null,
        formatId: format.itag,
        totalBytes: format.contentLength,
    });
    if (downloadingVideo) {
        await tabState.persist();
        notifyDownload(tabId, downloadingVideo);
    }
    return { success: true, downloadId };
}

async function handleFolderDownloadChange(downloadId, delta, association) {
    const changes = {};
    if (delta.state?.current === "complete") changes.status = FOLDER_DOWNLOAD_STATUSES.COMPLETE;
    else if (delta.state?.current === "interrupted") changes.status = FOLDER_DOWNLOAD_STATUSES.FAILED;
    else if (delta.state?.current === "in_progress") changes.status = FOLDER_DOWNLOAD_STATUSES.DOWNLOADING;
    if (delta.totalBytes?.current !== undefined && delta.totalBytes.current >= 0) {
        changes.totalBytes = delta.totalBytes.current;
    }
    if (delta.error?.current) {
        changes.status = FOLDER_DOWNLOAD_STATUSES.FAILED;
        changes.error = `Download failed (${delta.error.current}).`;
    }
    if (Object.keys(changes).length === 0) return;

    await updateFolderDownloadItemState(association.tabId, association.scanId, association.itemKey, changes);
    if ([FOLDER_DOWNLOAD_STATUSES.COMPLETE, FOLDER_DOWNLOAD_STATUSES.FAILED].includes(changes.status)) {
        folderDownloadById.delete(downloadId);
        await pumpFolderDownloadQueue(association.tabId, association.scanId);
        await maybeCompleteFolderDownload(association.tabId, association.scanId);
    }
}

async function handleDownloadChange(downloadId, delta) {
    const mappedFolderAssociation = folderDownloadById.get(downloadId);
    const storedFolderAssociation = tabState.findFolderDownloadByDownloadId(downloadId);
    const folderAssociation = mappedFolderAssociation ?? (storedFolderAssociation && {
        tabId: storedFolderAssociation.tabId,
        scanId: storedFolderAssociation.scanId,
        itemKey: storedFolderAssociation.item.key,
    });
    if (folderAssociation) {
        await handleFolderDownloadChange(downloadId, delta, folderAssociation);
        return;
    }

    const association = downloadById.get(downloadId) ?? tabState.findVideoByDownloadId(downloadId);
    if (!association) return;

    const changes = {};
    if (delta.state?.current) changes.status = normalizeDownloadState(delta.state.current);
    if (delta.error?.current) changes.error = formatDownloadChangeError(delta.error.current);
    if (Object.keys(changes).length === 0) return;

    const video = tabState.updateDownload(association.tabId, association.videoId, changes);
    if (!video) return;
    if (changes.status === "complete" || changes.status === "interrupted") downloadById.delete(downloadId);
    await tabState.persist();
    notifyDownload(association.tabId, video);
}

async function downloadVideos(tabId, videoIds) {
    const videos = tabState.getVideosByIds(tabId, videoIds);
    const tasks = videos.map((video) => async () => {
        if (video.download?.status === "downloading") {
            return { videoId: video.id, success: true, skipped: true };
        }
        return { videoId: video.id, ...(await startDownload(tabId, video.id)) };
    });
    const results = await runWithConcurrency(tasks, 3);
    return { success: results.some((result) => result.success), results };
}

async function startFolderScan(tabId) {
    if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
    const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
    if (!tab || tab.active !== true || !isGoogleDriveFolderUrl(tab.url)) {
        return { success: false, error: "Open a Google Drive folder to scan its files." };
    }

    const previousScan = tabState.getFolderScan(tabId);
    if (isActiveFolderScan(previousScan)) {
        return { success: false, error: "A folder scan is already in progress.", state: stateFor(tabId) };
    }

    const scanId = createScanId();
    folderScanRuntime.set(tabId, {
        scanId,
        cancelled: false,
        candidateTimer: null,
        advancePromise: null,
    });
    tabState.enableTab(tabId);
    const folderNameFromTitle = extractDriveFolderNameFromTitle(tab.title);
    tabState.updateFolderScan(tabId, {
        ...createFolderScanState({ now: Date.now() }),
        id: scanId,
        status: FOLDER_SCAN_STATUSES.DISCOVERING,
        folderId: extractDriveFolderId(tab.url),
        folderUrl: tab.url,
        returnUrl: tab.url,
        authuser: extractDriveAuthUser(tab.url),
        folderName: folderNameFromTitle,
        downloadDirectory: folderNameFromTitle
            ? sanitizePathSegment(folderNameFromTitle, "Google Drive Folder")
            : null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
    });
    await persistAndNotifyFolderScan(tabId);

    if (!await startCapture(tabId)) {
        await markFolderScanError(tabId, scanId, stateFor(tabId).lastError ?? "Unable to start capture for this Drive tab.");
        folderScanRuntime.delete(tabId);
        return { success: false, error: stateFor(tabId).lastError, state: stateFor(tabId) };
    }

    try {
        await startFolderDiscovery(tabId, scanId);
    } catch (error) {
        await markFolderScanError(tabId, scanId, scanErrorMessage(error));
        folderScanRuntime.delete(tabId);
        return { success: false, error: scanErrorMessage(error), state: stateFor(tabId) };
    }

    return { success: true, state: stateFor(tabId), videos: tabState.getVideosForTab(tabId) };
}

async function handleDiscoveryProgress(tabId, message) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== message.scanId || scan.status !== FOLDER_SCAN_STATUSES.DISCOVERING) return false;
    const discoveredCount = Number.isInteger(message.discoveredCount) && message.discoveredCount >= 0
        ? Math.max(scan.discoveredCount, message.discoveredCount)
        : scan.discoveredCount;
    tabState.updateFolderScan(tabId, {
        discoveredCount,
        discoveredVideoCount: Number.isInteger(message.discoveredVideoCount) && message.discoveredVideoCount >= 0
            ? Math.max(scan.discoveredVideoCount, message.discoveredVideoCount)
            : scan.discoveredVideoCount,
        discoveredRegularFileCount: Number.isInteger(message.discoveredRegularFileCount) && message.discoveredRegularFileCount >= 0
            ? Math.max(scan.discoveredRegularFileCount, message.discoveredRegularFileCount)
            : scan.discoveredRegularFileCount,
        discoveredUnsupportedCount: Number.isInteger(message.discoveredUnsupportedCount) && message.discoveredUnsupportedCount >= 0
            ? Math.max(scan.discoveredUnsupportedCount, message.discoveredUnsupportedCount)
            : scan.discoveredUnsupportedCount,
    });
    await persistAndNotifyFolderScan(tabId);
    return true;
}

async function handleDiscoveryComplete(tabId, message) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== message.scanId || scan.status !== FOLDER_SCAN_STATUSES.DISCOVERING) return false;
    const candidates = dedupeFolderCandidates(message.candidates).map((candidate) => normalizeFolderCandidate(candidate)).filter(Boolean);
    const regularFiles = dedupeRegularDriveFiles(message.regularFiles);
    const unsupportedFiles = dedupeUnsupportedDriveFiles(message.unsupportedFiles);
    const folderName = resolveDriveFolderName(scan.folderName, message.folderName);
    const discoveredCount = Number.isInteger(message.discoveredCount) && message.discoveredCount >= 0
        ? message.discoveredCount
        : candidates.length + regularFiles.length + unsupportedFiles.length;
    tabState.updateFolderScan(tabId, {
        status: candidates.length > 0 ? FOLDER_SCAN_STATUSES.COLLECTING : FOLDER_SCAN_STATUSES.DISCOVERING,
        candidates,
        total: candidates.length,
        currentIndex: 0,
        currentFileId: null,
        currentFileName: null,
        discoveredCount,
        discoveredVideoCount: candidates.length,
        discoveredRegularFileCount: regularFiles.length,
        discoveredUnsupportedCount: unsupportedFiles.length,
        folderName,
        downloadDirectory: sanitizePathSegment(folderName, "Google Drive Folder"),
        regularFiles,
        unsupportedFiles,
        error: null,
        pauseReason: null,
    });
    await persistAndNotifyFolderScan(tabId);
    if (candidates.length > 0) requestFolderAdvance(tabId, message.scanId);
    else await startFolderDownloadPhase(tabId, message.scanId);
    return true;
}

async function handleDiscoveryFailed(tabId, message) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== message.scanId || scan.status !== FOLDER_SCAN_STATUSES.DISCOVERING) return false;
    await markFolderScanError(tabId, message.scanId, "Unable to inspect this Drive folder.");
    folderScanRuntime.delete(tabId);
    return true;
}

async function handleDiscoveryCancelled(tabId, message) {
    const scan = tabState.getFolderScan(tabId);
    if (scan.id !== message.scanId || scan.status !== FOLDER_SCAN_STATUSES.DISCOVERING) return false;
    await cancelFolderScanInternal(tabId);
    return true;
}

async function retryFailedFolderScan(tabId) {
    if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
    const scan = tabState.getFolderScan(tabId);
    const failedCount = scan.candidates.filter((candidate) => candidate.status === FOLDER_CANDIDATE_STATUSES.FAILED).length;
    if (failedCount === 0) return { success: false, error: "There are no failed videos to retry." };
    if (isActiveFolderScan(scan)) return { success: false, error: "A folder scan is already in progress." };

    const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
    if (!tab || tab.active !== true || extractDriveFolderId(tab.url) !== scan.folderId) {
        return { success: false, error: "Return to the original Google Drive folder to retry failed videos." };
    }

    folderScanRuntime.set(tabId, { scanId: scan.id, cancelled: false, candidateTimer: null, advancePromise: null });
    tabState.enableTab(tabId);
    tabState.updateFolderScan(tabId, {
        status: FOLDER_SCAN_STATUSES.COLLECTING,
        candidates: retryFailedFolderCandidates(scan.candidates),
        currentIndex: 0,
        currentFileId: null,
        currentFileName: null,
        deadlineAt: null,
        pauseReason: null,
        error: null,
    });
    await persistAndNotifyFolderScan(tabId);
    if (!await startCapture(tabId)) {
        await markFolderScanError(tabId, scan.id, stateFor(tabId).lastError ?? "Unable to start capture for this Drive tab.");
        folderScanRuntime.delete(tabId);
        return { success: false, error: stateFor(tabId).lastError, state: stateFor(tabId) };
    }
    requestFolderAdvance(tabId, scan.id);
    return { success: true, state: stateFor(tabId), videos: tabState.getVideosForTab(tabId) };
}

async function recoverFolderDownloads(state, tab) {
    const scan = tabState.getFolderScan(state.tabId);
    if (scan.status !== FOLDER_SCAN_STATUSES.DOWNLOADING) return false;

    for (const item of scan.downloadItems) {
        if (!Number.isInteger(item.downloadId)) continue;
        const downloads = await chromeCall(
            chrome.downloads.search.bind(chrome.downloads),
            { id: item.downloadId },
        ).catch(() => []);
        const browserDownload = downloads?.[0];
        if (!browserDownload) continue;

        if (browserDownload.state === "in_progress") {
            folderDownloadById.set(item.downloadId, { tabId: state.tabId, scanId: scan.id, itemKey: item.key });
            await updateFolderDownloadItemState(state.tabId, scan.id, item.key, {
                status: FOLDER_DOWNLOAD_STATUSES.DOWNLOADING,
                error: null,
            });
        } else if (browserDownload.state === "complete") {
            await updateFolderDownloadItemState(state.tabId, scan.id, item.key, {
                status: FOLDER_DOWNLOAD_STATUSES.COMPLETE,
                totalBytes: browserDownload.fileSize >= 0 ? browserDownload.fileSize : item.totalBytes,
            });
        } else if (browserDownload.state === "interrupted") {
            await updateFolderDownloadItemState(state.tabId, scan.id, item.key, {
                status: FOLDER_DOWNLOAD_STATUSES.FAILED,
                error: `Download failed (${browserDownload.error ?? "interrupted"}).`,
            });
        }
    }

    const currentScan = tabState.getFolderScan(state.tabId);
    const canPrepare = tab?.active === true && isGoogleDriveUrl(tab.url);
    if (canPrepare) {
        const preparingItems = currentScan.downloadItems.filter((item) => item.status === FOLDER_DOWNLOAD_STATUSES.PREPARING);
        if (preparingItems.length > 0) {
            tabState.updateFolderScan(state.tabId, {
                downloadItems: currentScan.downloadItems.map((item) => item.status === FOLDER_DOWNLOAD_STATUSES.PREPARING
                    ? { ...item, status: FOLDER_DOWNLOAD_STATUSES.PENDING }
                    : item),
            });
            await persistAndNotifyFolderScan(state.tabId);
        }
        await pumpFolderDownloadQueue(state.tabId, scan.id);
    }
    await maybeCompleteFolderDownload(state.tabId, scan.id);
    return true;
}

async function recoverFolderScan(state, tab) {
    const scan = state.folderScan;
    if (!isActiveFolderScan(scan)) return;
    if (scan.status === FOLDER_SCAN_STATUSES.DOWNLOADING) {
        await recoverFolderDownloads(state, tab);
        return;
    }
    if (!tab || !isGoogleDriveUrl(tab.url)) return;
    const previousCandidate = scan.currentIndex > 0 ? scan.candidates[scan.currentIndex - 1] : null;
    const isPreviousCandidatePage = scan.total > 0
        && extractDriveFileIdFromUrl(tab.url) === previousCandidate?.fileId;
    if (!scan.currentFileId && extractDriveFolderId(tab.url) !== scan.folderId && !isPreviousCandidatePage) {
        await cancelFolderScanInternal(state.tabId, "Folder scan stopped because the Drive tab navigation changed.");
        return;
    }

    if (tab.active !== true) {
        if (scan.status !== FOLDER_SCAN_STATUSES.PAUSED) {
            tabState.updateFolderScan(state.tabId, {
                status: FOLDER_SCAN_STATUSES.PAUSED,
                pauseReason: "Return to this Drive tab to continue.",
            });
            await persistAndNotifyFolderScan(state.tabId);
        }
        return;
    }

    folderScanRuntime.set(state.tabId, {
        scanId: scan.id,
        cancelled: false,
        candidateTimer: null,
        advancePromise: null,
    });
    if (!await startCapture(state.tabId)) return;

    const currentScan = tabState.getFolderScan(state.tabId);
    if (currentScan.status === FOLDER_SCAN_STATUSES.PAUSED) {
        await resumeFolderScan(state.tabId);
        return;
    }
    if (currentScan.status === FOLDER_SCAN_STATUSES.COLLECTING && currentScan.currentFileId) {
        tabState.updateFolderScan(state.tabId, {
            status: FOLDER_SCAN_STATUSES.PAUSED,
            pauseReason: "Capture is recovering after a service worker restart.",
        });
        await persistAndNotifyFolderScan(state.tabId);
        await resumeFolderScan(state.tabId);
        return;
    }
    if (currentScan.status === FOLDER_SCAN_STATUSES.DISCOVERING) {
        try {
        await startFolderDiscovery(state.tabId, currentScan.id);
        } catch (error) {
            await markFolderScanError(state.tabId, currentScan.id, scanErrorMessage(error));
        }
        return;
    }
    requestFolderAdvance(state.tabId, currentScan.id);
}

async function handleMessage(message, sender) {
    if (!message || !message.type) return { success: false, error: "Invalid message." };
    const tabId = Number.isInteger(message.tabId) ? message.tabId : sender?.tab?.id;

    if (message.type === MESSAGE_TYPES.GET_TAB_STATE) {
        if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
        const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
        if (tab?.active && isGoogleDriveUrl(tab.url) && tabState.isTabEnabled(tabId)) {
            const scan = tabState.getFolderScan(tabId);
            if (scan.status === FOLDER_SCAN_STATUSES.DOWNLOADING) {
                await recoverFolderDownloads({ tabId }, tab);
            } else {
                await startCapture(tabId);
                if (scan.status === FOLDER_SCAN_STATUSES.PAUSED) await resumeFolderScan(tabId);
            }
        }
        return { success: true, state: stateFor(tabId), videos: tabState.getVideosForTab(tabId) };
    }

    if (message.type === MESSAGE_TYPES.START_FOLDER_SCAN) return startFolderScan(tabId);

    if (message.type === MESSAGE_TYPES.CANCEL_FOLDER_SCAN) {
        if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
        const cancelled = await cancelFolderScanInternal(tabId);
        return cancelled
            ? { success: true, state: stateFor(tabId), videos: tabState.getVideosForTab(tabId) }
            : { success: false, error: "No folder scan is in progress.", state: stateFor(tabId) };
    }

    if (message.type === MESSAGE_TYPES.RETRY_FAILED_FOLDER_SCAN) return retryFailedFolderScan(tabId);

    if (message.type === MESSAGE_TYPES.FOLDER_DISCOVERY_PROGRESS) {
        await handleDiscoveryProgress(tabId, message);
        return { success: true };
    }

    if (message.type === MESSAGE_TYPES.FOLDER_DISCOVERY_COMPLETE) {
        await handleDiscoveryComplete(tabId, message);
        return { success: true };
    }

    if (message.type === MESSAGE_TYPES.FOLDER_DISCOVERY_FAILED) {
        await handleDiscoveryFailed(tabId, message);
        return { success: true };
    }

    if (message.type === MESSAGE_TYPES.FOLDER_DISCOVERY_CANCELLED) {
        await handleDiscoveryCancelled(tabId, message);
        return { success: true };
    }

    if (message.type === MESSAGE_TYPES.SET_TAB_ENABLED) {
        if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
        const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
        if (!tab || !isGoogleDriveUrl(tab.url)) {
            return { success: false, error: "Open a Google Drive tab to use capture." };
        }

        if (!message.enabled) {
            await disableCapture(tabId);
            return { success: true, state: stateFor(tabId), videos: tabState.getVideosForTab(tabId) };
        }

        const wasEnabled = tabState.isTabEnabled(tabId);
        tabState.enableTab(tabId);
        await tabState.persist();
        notifyTabState(tabId);
        const started = await startCapture(tabId);
        if (started && message.reload && !wasEnabled) {
            await chromeCall(chrome.tabs.reload.bind(chrome.tabs), tabId).catch((error) => {
                debugLog("Drive reload failed", error.message);
            });
        }
        return {
            success: started,
            state: stateFor(tabId),
            videos: tabState.getVideosForTab(tabId),
            error: started ? null : stateFor(tabId).lastError,
        };
    }

    if (message.type === MESSAGE_TYPES.SET_SELECTION) {
        if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
        const result = await operationForTab(tabId, async () => {
            const selection = tabState.setSelectedVideoIds(tabId, message.selectedVideoIds);
            await tabState.persist();
            notifyTabState(tabId);
            return selection;
        });
        return {
            success: true,
            selectedVideoIds: result.selectedVideoIds,
            state: stateFor(tabId),
            videos: tabState.getVideosForTab(tabId),
        };
    }

    if (message.type === MESSAGE_TYPES.CLEAR_VIDEOS) {
        if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
        if (isActiveFolderScan(tabState.getFolderScan(tabId))) {
            return { success: false, error: "Cancel the folder scan before clearing the collection." };
        }
        await operationForTab(tabId, async () => {
            tabState.clearTabVideos(tabId);
            await tabState.persist();
            await updateBadge(tabId);
            notifyTabState(tabId);
        });
        return { success: true, state: stateFor(tabId), videos: [] };
    }

    if (message.type === MESSAGE_TYPES.DOWNLOAD_VIDEO) {
        if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
        return startDownload(tabId, message.videoId, message.formatId ?? null, message.formatKey ?? null);
    }

    if (message.type === MESSAGE_TYPES.DOWNLOAD_SELECTED) {
        if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
        return downloadVideos(tabId, message.videoIds);
    }

    return { success: false, error: "Unknown message type." };
}

async function initialize() {
    await tabState.hydrate();
    let changed = false;
    for (const state of tabState.getAllStates()) {
        const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), state.tabId).catch(() => null);
        if (!tab || !isGoogleDriveUrl(tab.url)) {
            tabState.removeTab(state.tabId);
            changed = true;
        }
    }
    if (changed) await tabState.persist();
}

const ready = initialize().catch((error) => console.error("Unable to hydrate session state", error));

ready.then(() => {
    for (const state of tabState.getAllStates()) {
        void chromeCall(chrome.tabs.get.bind(chrome.tabs), state.tabId)
            .catch(() => null)
            .then((tab) => {
                if (isActiveFolderScan(state.folderScan)) return recoverFolderScan(state, tab);
                if (state.enabled) return startCapture(state.tabId);
                return undefined;
            })
            .catch((error) => console.error("Unable to recover tab state", error));
    }
});

async function handleTabActivated(activeInfo) {
    const activeTab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), activeInfo.tabId).catch(() => null);
    const states = tabState.getAllStates();

    for (const state of states) {
        if (!state.enabled || state.tabId === activeInfo.tabId) continue;
        const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), state.tabId).catch(() => null);
        if (tab && isGoogleDriveUrl(tab.url)) {
            await pauseFolderScan(state.tabId, "Return to this Drive tab to continue.");
            if (stateFor(state.tabId).debuggerAttached) await detachInactiveTab(state.tabId);
        }
    }

    if (activeTab && isGoogleDriveUrl(activeTab.url) && tabState.isTabEnabled(activeInfo.tabId)) {
        const activeScan = tabState.getFolderScan(activeInfo.tabId);
        if (activeScan.status === FOLDER_SCAN_STATUSES.DOWNLOADING) {
            await recoverFolderDownloads({ tabId: activeInfo.tabId }, activeTab);
        } else if (isFolderCaptureActive(activeScan)) {
            await startCapture(activeInfo.tabId);
            if (activeScan.status === FOLDER_SCAN_STATUSES.PAUSED) {
                await resumeFolderScan(activeInfo.tabId);
            } else if (activeScan.status === FOLDER_SCAN_STATUSES.COLLECTING) {
                requestFolderAdvance(activeInfo.tabId, activeScan.id);
            }
        }
    }
}

async function handleFolderNavigationUpdate(tabId, url) {
    const scan = tabState.getFolderScan(tabId);
    if (!isFolderCaptureActive(scan) || !url) return false;

    const expected = expectedNavigationMatches(tabId, url);
    const fileId = extractDriveFileIdFromUrl(url);
    const folderId = extractDriveFolderId(url);
    if (expected) return true;

    if (scan.status === FOLDER_SCAN_STATUSES.DISCOVERING || (!scan.currentFileId && folderId === scan.folderId)) {
        if (folderId === scan.folderId) return true;
    } else if (scan.currentFileId && fileId === scan.currentFileId) {
        setExpectedFolderNavigation(tabId, {
            kind: "candidate",
            scanId: scan.id,
            fileId: scan.currentFileId,
        });
        return true;
    } else if (!scan.currentFileId && scan.total > 0 && scan.currentIndex > 0
        && fileId === scan.candidates[scan.currentIndex - 1]?.fileId) {
        return true;
    }

    await cancelFolderScanInternal(tabId, "Folder scan stopped because the Drive tab navigation changed.");
    return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void ready
        .then(() => handleMessage(message, sender))
        .then(sendResponse)
        .catch((error) => {
            console.error("Message handling failed", error);
            sendResponse({ success: false, error: error.message });
        });
    return true;
});

chrome.debugger.onEvent.addListener((debuggeeId, method, params) => {
    void ready.then(() => handleDebuggerEvent(debuggeeId, method, params)).catch((error) => {
        console.error("Debugger event handling failed", error);
    });
});

chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId)) return;

    void ready.then(() => operationForTab(tabId, async () => {
        removePendingRequests(tabId);
        const expected = expectedDetachTabs.has(tabId);
        if (expected) clearExpectedDetach(tabId);
        if (cleanupTabs.has(tabId) || !tabState.isTabEnabled(tabId)) return;
        tabState.setDebuggerAttached(tabId, false);

        const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
        if (expected || tab?.active !== true) {
            await pauseFolderScan(tabId, "Return to this Drive tab to continue.");
            tabState.setLastError(tabId, null);
            await tabState.persist();
            notifyStateAndFolderScan(tabId);
            return;
        }

        const state = stateFor(tabId);
        const external = EXTERNAL_DEBUGGER_REASONS.has(reason);
        const activeScan = tabState.getFolderScan(tabId);
        if (external && isFolderCaptureActive(activeScan)) {
            await markFolderScanError(tabId, activeScan.id, "Capture stopped because another debugging session is using this tab.");
        }
        tabState.setLastError(
            tabId,
            external ? "Capture stopped because another debugging session is using this tab." : `Debugger detached: ${reason}.`,
        );
        await tabState.persist();
        notifyStateAndFolderScan(tabId);

        const now = Date.now();
        const shouldRetry = state.enabled && !external && now - (lastDetachAt.get(tabId) ?? 0) > REATTACH_COOLDOWN_MS;
        lastDetachAt.set(tabId, now);
        if (shouldRetry) setTimeout(() => void startCapture(tabId), 250);
    })).catch((error) => console.error("Debugger detach handling failed", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void ready.then(async () => {
        const url = changeInfo.url ?? tab?.url;
        if (url && !isGoogleDriveUrl(url) && tabState.hasTab(tabId)) {
            await leaveDrive(tabId);
            return;
        }

        if (
            url
            && isGoogleDriveUrl(url)
            && isFolderCaptureActive(tabState.getFolderScan(tabId))
            && (changeInfo.url || changeInfo.status === "complete")
        ) {
            const expected = await handleFolderNavigationUpdate(tabId, url);
            if (!expected && !isFolderCaptureActive(tabState.getFolderScan(tabId))) return;
        }

        if (changeInfo.status === "loading" && tabState.getFolderScan(tabId).status === FOLDER_SCAN_STATUSES.DISCOVERING) {
            const runtime = folderRuntimeFor(tabId, tabState.getFolderScan(tabId).id);
            if (runtime) runtime.discoveryStarted = false;
        }

        if (
            (changeInfo.url || changeInfo.status === "loading") &&
            isGoogleDriveUrl(url) &&
            tabState.isTabEnabled(tabId)
        ) {
            removePendingRequests(tabId);
        }

        if (changeInfo.status === "complete" && isGoogleDriveUrl(tab?.url) && tabState.isTabEnabled(tabId)) {
            const scan = tabState.getFolderScan(tabId);
            if (scan.status !== FOLDER_SCAN_STATUSES.DOWNLOADING) await startCapture(tabId);
            if (scan.status === FOLDER_SCAN_STATUSES.DISCOVERING && extractDriveFolderId(tab.url) === scan.folderId) {
                try {
                    await startFolderDiscovery(tabId, scan.id);
                } catch (error) {
                    await markFolderScanError(tabId, scan.id, scanErrorMessage(error));
                }
            }
        }
    }).catch((error) => console.error("Tab update handling failed", error));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    void ready.then(() => handleTabActivated(activeInfo)).catch((error) => {
        console.error("Tab activation handling failed", error);
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    void ready.then(() => cleanupTabResources(tabId, { clearVideos: true, removeState: true })).catch((error) => {
        console.error("Tab cleanup failed", error);
    });
});

chrome.downloads.onChanged.addListener((delta) => {
    if (delta?.id === undefined) return;
    void ready.then(() => handleDownloadChange(delta.id, delta)).catch((error) => {
        console.error("Download state handling failed", error);
    });
});
