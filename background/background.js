import { parseDriveVideoResponse } from "../lib/drive-parser.js";
import { MESSAGE_TYPES } from "../lib/messages.js";
import { createTabStateManager } from "../lib/tab-state.js";
import {
    createVideoRecord,
    formatIdentity,
    sanitizeFilename,
    selectBestProgressiveFormat,
} from "../lib/video-model.js";
import {
    isGoogleDriveUrl,
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
const cleanupTabs = new Set();
const expectedDetachTabs = new Set();
const expectedDetachTimers = new Map();
const lastDetachAt = new Map();

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
    await tabState.persist();
    notifyTabState(tabId);
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
            debugLog("Ignored non-JSON playback response", request.url);
            return;
        }

        const parsedVideo = parseDriveVideoResponse(data);
        if (!parsedVideo || !tabState.isTabEnabled(tabId)) return;

        const video = createVideoRecord(parsedVideo, tabId);
        const resultForVideo = tabState.addOrUpdateVideo(tabId, video);
        if (!resultForVideo.changed) return;

        await tabState.persist();
        await updateBadge(tabId);
        notifyVideoChange(
            tabId,
            resultForVideo.isNew ? MESSAGE_TYPES.VIDEO_DETECTED : MESSAGE_TYPES.VIDEO_UPDATED,
            resultForVideo.video,
        );
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

async function handleDownloadChange(downloadId, delta) {
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

async function handleMessage(message, sender) {
    if (!message || !message.type) return { success: false, error: "Invalid message." };
    const tabId = Number.isInteger(message.tabId) ? message.tabId : sender?.tab?.id;

    if (message.type === MESSAGE_TYPES.GET_TAB_STATE) {
        if (!Number.isInteger(tabId)) return { success: false, error: "No active tab." };
        const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), tabId).catch(() => null);
        if (tab?.active && isGoogleDriveUrl(tab.url) && tabState.isTabEnabled(tabId)) {
            await startCapture(tabId);
        }
        return { success: true, state: stateFor(tabId), videos: tabState.getVideosForTab(tabId) };
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
        if (state.enabled) void startCapture(state.tabId);
    }
});

async function handleTabActivated(activeInfo) {
    const activeTab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), activeInfo.tabId).catch(() => null);
    const states = tabState.getAllStates();

    for (const state of states) {
        if (!state.enabled || state.tabId === activeInfo.tabId || !state.debuggerAttached) continue;
        const tab = await chromeCall(chrome.tabs.get.bind(chrome.tabs), state.tabId).catch(() => null);
        if (tab?.windowId === activeInfo.windowId && isGoogleDriveUrl(tab.url)) {
            await detachInactiveTab(state.tabId);
        }
    }

    if (activeTab && isGoogleDriveUrl(activeTab.url) && tabState.isTabEnabled(activeInfo.tabId)) {
        await startCapture(activeInfo.tabId);
    }
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
            tabState.setLastError(tabId, null);
            await tabState.persist();
            notifyTabState(tabId);
            return;
        }

        const state = stateFor(tabId);
        const external = EXTERNAL_DEBUGGER_REASONS.has(reason);
        tabState.setLastError(
            tabId,
            external ? "Capture stopped because another debugging session is using this tab." : `Debugger detached: ${reason}.`,
        );
        await tabState.persist();
        notifyTabState(tabId);

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
            (changeInfo.url || changeInfo.status === "loading") &&
            isGoogleDriveUrl(url) &&
            tabState.isTabEnabled(tabId)
        ) {
            removePendingRequests(tabId);
        }

        if (changeInfo.status === "complete" && isGoogleDriveUrl(tab?.url) && tabState.isTabEnabled(tabId)) {
            await startCapture(tabId);
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
