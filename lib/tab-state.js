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
        lastError: null,
    };
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
                    videos: Array.isArray(storedState.videos) ? storedState.videos : [],
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
            state.videos = [];
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

        addOrUpdateVideo(tabId, video) {
            const state = getOrCreate(tabId);
            const index = state.videos.findIndex((existing) => areVideosSame(existing, video));
            if (index === -1) {
                state.videos.push(clone(video));
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
            const changed = state.videos.length > 0;
            state.videos = [];
            return changed;
        },

        updateDownload(tabId, videoId, download) {
            const state = states.get(tabId);
            const video = state?.videos.find((item) => item.id === videoId);
            if (!video) return null;
            video.download = { ...(video.download ?? {}), ...download };
            return clone(video);
        },

        findVideo(tabId, videoId) {
            return clone(states.get(tabId)?.videos.find((video) => video.id === videoId));
        },

        findVideoByDownloadId(downloadId) {
            for (const state of states.values()) {
                const video = state.videos.find((item) => item.download?.downloadId === downloadId);
                if (video) return { tabId: state.tabId, video: clone(video) };
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
