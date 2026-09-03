import { areVideosSame, mergeVideo } from "./video-model.js";

const DEFAULT_STORAGE_KEY = "tabStates";

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createState(tabId) {
    return {
        tabId,
        enabled: false,
        debuggerAttached: false,
        videos: [],
        selectedVideoIds: [],
        lastError: null,
    };
}

function normalizeDownload(download) {
    if (!download || typeof download !== "object") return download ?? null;
    const status = download.status === "in_progress"
        ? "downloading"
        : download.status === "completed"
        ? "complete"
        : download.status;
    return { ...download, status };
}

function validSelection(videos, selectedVideoIds) {
    const videoIds = new Set((videos ?? []).map((video) => video.id));
    return [...new Set((Array.isArray(selectedVideoIds) ? selectedVideoIds : []).filter((id) => videoIds.has(id)))];
}

export function createTabStateManager({ storage, storageKey = DEFAULT_STORAGE_KEY } = {}) {
    const states = new Map();
    let persistQueue = Promise.resolve();

    function getOrCreate(tabId) {
        if (!states.has(tabId)) states.set(tabId, createState(tabId));
        return states.get(tabId);
    }

    function snapshot() {
        return Object.fromEntries(
            [...states.entries()].map(([tabId, state]) => [String(tabId), { ...state, debuggerAttached: false }]),
        );
    }

    return {
        async hydrate() {
            if (!storage?.get) return;
            const result = await storage.get(storageKey);
            const storedStates = result?.[storageKey];
            if (!storedStates || typeof storedStates !== "object") return;

            for (const [tabIdString, storedState] of Object.entries(storedStates)) {
                const tabId = Number(tabIdString);
                if (!Number.isInteger(tabId) || !storedState || typeof storedState !== "object") continue;
                states.set(tabId, {
                    ...createState(tabId),
                    ...storedState,
                    tabId,
                    debuggerAttached: false,
                    videos: Array.isArray(storedState.videos)
                        ? storedState.videos.map((video) => ({
                              ...video,
                              download: normalizeDownload(video.download),
                          }))
                        : [],
                    selectedVideoIds: validSelection(
                        Array.isArray(storedState.videos) ? storedState.videos : [],
                        storedState.selectedVideoIds,
                    ),
                });
            }
        },

        persist() {
            if (!storage?.set) return Promise.resolve();
            const data = { [storageKey]: snapshot() };
            persistQueue = persistQueue.catch(() => undefined).then(() => storage.set(data));
            return persistQueue;
        },

        getState(tabId) {
            const state = states.get(tabId);
            return clone(state ?? createState(tabId));
        },

        getAllStates() {
            return clone([...states.values()]);
        },

        hasTab(tabId) {
            return states.has(tabId);
        },

        enableTab(tabId) {
            const state = getOrCreate(tabId);
            state.enabled = true;
            state.lastError = null;
            return clone(state);
        },

        disableTab(tabId) {
            const state = getOrCreate(tabId);
            state.enabled = false;
            state.debuggerAttached = false;
            state.lastError = null;
            return clone(state);
        },

        isTabEnabled(tabId) {
            return states.get(tabId)?.enabled === true;
        },

        setDebuggerAttached(tabId, attached) {
            const state = getOrCreate(tabId);
            state.debuggerAttached = Boolean(attached);
            return clone(state);
        },

        setLastError(tabId, error) {
            const state = getOrCreate(tabId);
            state.lastError = error ? String(error) : null;
            state.debuggerAttached = error ? false : state.debuggerAttached;
            return clone(state);
        },

        getVideosForTab(tabId) {
            return clone(states.get(tabId)?.videos ?? []);
        },

        getVideosByIds(tabId, videoIds) {
            const requestedIds = new Set(Array.isArray(videoIds) ? videoIds : []);
            return clone((states.get(tabId)?.videos ?? []).filter((video) => requestedIds.has(video.id)));
        },

        addOrUpdateVideo(tabId, video) {
            const state = getOrCreate(tabId);
            if (!Array.isArray(state.selectedVideoIds)) state.selectedVideoIds = [];
            const index = state.videos.findIndex((existing) => areVideosSame(existing, video));
            if (index === -1) {
                state.videos.push(clone(video));
                if (!state.selectedVideoIds.includes(video.id)) state.selectedVideoIds.push(video.id);
                return { video: clone(video), isNew: true, changed: true };
            }

            const merged = mergeVideo(state.videos[index], video);
            const changed = JSON.stringify(merged) !== JSON.stringify(state.videos[index]);
            state.videos[index] = merged;
            return { video: clone(merged), isNew: false, changed };
        },

        clearTabVideos(tabId) {
            const state = states.get(tabId);
            if (!state) return false;
            const changed = state.videos.length > 0 || (state.selectedVideoIds ?? []).length > 0;
            state.videos = [];
            state.selectedVideoIds = [];
            return changed;
        },

        getSelectedVideoIds(tabId) {
            return clone(validSelection(
                states.get(tabId)?.videos ?? [],
                states.get(tabId)?.selectedVideoIds,
            ));
        },

        setSelectedVideoIds(tabId, selectedVideoIds) {
            const state = getOrCreate(tabId);
            const nextSelection = validSelection(state.videos, selectedVideoIds);
            const changed = JSON.stringify(state.selectedVideoIds ?? []) !== JSON.stringify(nextSelection);
            state.selectedVideoIds = nextSelection;
            return { selectedVideoIds: clone(nextSelection), changed };
        },

        updateDownload(tabId, videoId, download) {
            const state = states.get(tabId);
            const video = state?.videos.find((item) => item.id === videoId);
            if (!video) return null;
            video.download = normalizeDownload({ ...(video.download ?? {}), ...download });
            return clone(video);
        },

        findVideo(tabId, videoId) {
            return clone(states.get(tabId)?.videos.find((video) => video.id === videoId));
        },

        findVideoByDownloadId(downloadId) {
            for (const state of states.values()) {
                const video = state.videos.find((item) => item.download?.downloadId === downloadId);
                if (video) return { tabId: state.tabId, videoId: video.id, video: clone(video) };
            }
            return null;
        },

        removeTab(tabId) {
            states.delete(tabId);
        },

        clearAll() {
            states.clear();
        },
    };
}
