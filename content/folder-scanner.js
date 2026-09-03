(() => {
    const SCANNER_KEY = "__driveVideoFolderScanner";
    const MAX_DURATION_MS = 60_000;
    const MAX_PASSES = 240;
    const IDLE_BOTTOM_PASSES = 4;
    const WAIT_AFTER_SCROLL_MS = 140;
    const MESSAGE_TYPES = Object.freeze({
        START: "FOLDER_SCANNER_START",
        CANCEL: "FOLDER_SCANNER_CANCEL",
        PROGRESS: "FOLDER_DISCOVERY_PROGRESS",
        COMPLETE: "FOLDER_DISCOVERY_COMPLETE",
        FAILED: "FOLDER_DISCOVERY_FAILED",
        CANCELLED: "FOLDER_DISCOVERY_CANCELLED",
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

    function send(type, payload) {
        try {
            chrome.runtime.sendMessage({ type, ...payload }, () => {
                void chrome.runtime.lastError;
            });
        } catch {
            // The page can be navigating while a discovery event is emitted.
        }
    }

    function normalizedText(value) {
        return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    }

    function isValidFileId(value) {
        if (typeof value !== "string") return false;
        const id = value.trim();
        if (id.length < 3 || id.length > 512) return false;
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
        if (/^\d+$/.test(id) || /^(?:row|menu|item)[-_]/i.test(id)) return false;
        return true;
    }

    function isLikelyVideoFilename(value) {
        const match = normalizedText(value).match(/\.([a-z0-9]{2,8})$/i);
        return Boolean(match && VIDEO_EXTENSIONS.has(match[1].toLowerCase()));
    }

    function isDriveFolderHref(value) {
        return typeof value === "string" && /(?:^|\/)folders\/[A-Za-z0-9_-]+(?:\/|$)/.test(value);
    }

    function idFromHref(value) {
        if (typeof value !== "string") return null;
        const pathMatch = value.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
        if (pathMatch && isValidFileId(pathMatch[1])) return pathMatch[1];

        try {
            const url = new URL(value, window.location.href);
            if (url.hostname !== "drive.google.com") return null;
            const queryId = url.searchParams.get("id");
            return isValidFileId(queryId) ? queryId : null;
        } catch {
            return null;
        }
    }

    function itemRoot(element) {
        return element.closest("[role='row'], [role='gridcell'], [role='listitem'], [data-file-id]") ?? element;
    }

    function isFolderElement(element) {
        const values = [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-tooltip"),
            element.getAttribute("data-type"),
            element.getAttribute("data-mime-type"),
        ].map((value) => normalizedText(value).toLowerCase());
        return values.some((value) => value === "folder" || value.includes("folder"))
            || Boolean(element.closest("a[href]")?.getAttribute("href")
                && isDriveFolderHref(element.closest("a[href]").getAttribute("href")));
    }

    function idFromElement(element) {
        const href = element.matches("a[href]") ? element.getAttribute("href") : element.querySelector("a[href]")?.getAttribute("href");
        const hrefId = idFromHref(href);
        if (hrefId) return hrefId;

        const root = itemRoot(element);
        const attributes = ["data-file-id", "data-target-id"];
        if (["row", "gridcell", "listitem"].includes(root.getAttribute("role"))) attributes.push("data-id");
        for (const attribute of attributes) {
            const value = root.getAttribute(attribute);
            if (isValidFileId(value)) return value.trim();
        }
        return null;
    }

    function textCandidates(element) {
        const root = itemRoot(element);
        const values = [
            element.getAttribute("data-tooltip"),
            element.getAttribute("title"),
            element.getAttribute("aria-label"),
            element.textContent,
            root.getAttribute("data-tooltip"),
            root.getAttribute("title"),
            root.getAttribute("aria-label"),
        ];
        for (const node of root.querySelectorAll("a, [data-tooltip], [title], [aria-label]")) {
            values.push(
                node.getAttribute("data-tooltip"),
                node.getAttribute("title"),
                node.getAttribute("aria-label"),
                node.textContent,
            );
        }
        return [...new Set(values.map(normalizedText).filter(Boolean))];
    }

    function nameFromElement(element) {
        const values = textCandidates(element);
        return values.find((value) => isLikelyVideoFilename(value))
            ?? values.find((value) => value.length <= 240 && !/[|·•]\s*(owner|modified|size|date)/i.test(value))
            ?? "Untitled video";
    }

    function semanticMetadata(element) {
        const root = itemRoot(element);
        return {
            type: root.getAttribute("data-type") ?? root.getAttribute("data-mime-type") ?? "",
            ariaLabel: [root.getAttribute("aria-label"), element.getAttribute("aria-label")].filter(Boolean).join(" "),
        };
    }

    function candidateFromElement(element) {
        if (isFolderElement(element)) return null;
        const fileId = idFromElement(element);
        if (!fileId) return null;
        const name = nameFromElement(element);
        const metadata = semanticMetadata(element);
        const isVideo = isLikelyVideoFilename(name) || /^video\//i.test(metadata.type)
            || metadata.type.toLowerCase() === "video"
            || /\bvideo\b/i.test(metadata.ariaLabel);
        if (!isVideo) return null;
        return {
            fileId,
            name,
            url: `https://drive.google.com/file/d/${fileId}/view`,
            isVideo: true,
            status: "pending",
            attempts: 0,
            videoId: null,
            error: null,
        };
    }

    function collectCandidates(root) {
        const elements = [root, ...root.querySelectorAll(
            "a[href], [data-file-id], [data-target-id], [data-id], [role='row'], [role='gridcell'], [role='listitem']",
        )];
        const candidates = [];
        const seenIds = new Set();
        for (const element of elements) {
            const candidate = candidateFromElement(element);
            if (!candidate || seenIds.has(candidate.fileId)) continue;
            seenIds.add(candidate.fileId);
            candidates.push(candidate);
        }
        return candidates;
    }

    function isExcludedContainer(element) {
        const role = element.getAttribute("role");
        if (["navigation", "complementary", "dialog", "menu", "menubar"].includes(role)) return true;
        const label = normalizedText(element.getAttribute("aria-label")).toLowerCase();
        return label.includes("sidebar") || label.includes("navigation");
    }

    function findScrollContainer(root) {
        const elements = [root, ...root.querySelectorAll("*")];
        let best = null;
        let bestScore = -1;
        for (const element of elements) {
            if (isExcludedContainer(element) || element.clientHeight < 80) continue;
            if (element.scrollHeight <= element.clientHeight + 20) continue;
            const candidateCount = collectCandidates(element).length;
            const style = window.getComputedStyle(element);
            const overflowScore = ["auto", "scroll"].includes(style.overflowY) ? 1000 : 0;
            const roleScore = ["grid", "tree", "list", "main"].includes(element.getAttribute("role")) ? 50 : 0;
            const score = candidateCount * 100 + overflowScore + roleScore;
            if (score > bestScore) {
                best = element;
                bestScore = score;
            }
        }
        return best;
    }

    function waitForDomUpdate() {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                observer.disconnect();
                clearTimeout(timer);
                resolve();
            };
            const observer = new window.MutationObserver(finish);
            observer.observe(document.body, { childList: true, subtree: true });
            const timer = setTimeout(finish, WAIT_AFTER_SCROLL_MS);
            window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
        });
    }

    function isCancelled(scanId, controller) {
        const activeController = globalThis[SCANNER_KEY];
        return activeController !== controller || activeController?.scanId !== scanId || activeController.cancelled === true;
    }

    async function discover(scanId, controller) {
        const startedAt = Date.now();
        const root = document.querySelector("[role='main']") ?? document.body;
        if (!root) {
            send(MESSAGE_TYPES.FAILED, { scanId, error: "Unable to inspect this Drive folder." });
            return;
        }

        const container = findScrollContainer(root);
        const originalScrollTop = container?.scrollTop ?? 0;
        const byId = new Map();
        let lastReportedCount = 0;
        let idleBottomPasses = 0;

        const reportProgress = (force = false) => {
            if (!force && byId.size === lastReportedCount) return;
            lastReportedCount = byId.size;
            send(MESSAGE_TYPES.PROGRESS, { scanId, discoveredCount: byId.size });
        };

        try {
            if (container) {
                container.scrollTop = 0;
                await waitForDomUpdate();
            }

            for (let pass = 0; pass < MAX_PASSES; pass += 1) {
                if (isCancelled(scanId, controller)) {
                    send(MESSAGE_TYPES.CANCELLED, { scanId });
                    return;
                }
                if (Date.now() - startedAt >= MAX_DURATION_MS) break;

                const before = byId.size;
                for (const candidate of collectCandidates(root)) {
                    if (!byId.has(candidate.fileId)) byId.set(candidate.fileId, candidate);
                }
                reportProgress();

                if (!container) break;
                const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
                if (atBottom && byId.size === before) idleBottomPasses += 1;
                else if (!atBottom || byId.size > before) idleBottomPasses = 0;
                if (atBottom && idleBottomPasses >= IDLE_BOTTOM_PASSES) break;

                const step = Math.max(container.clientHeight * 0.8, 320);
                const nextScrollTop = Math.min(container.scrollHeight, container.scrollTop + step);
                if (nextScrollTop === container.scrollTop && !atBottom) container.scrollTop += 320;
                else container.scrollTop = nextScrollTop;
                await waitForDomUpdate();
            }
        } finally {
            if (globalThis[SCANNER_KEY] === controller && container) {
                container.scrollTop = originalScrollTop;
                await waitForDomUpdate();
            }
        }

        if (!isCancelled(scanId, controller)) {
            reportProgress(true);
            send(MESSAGE_TYPES.COMPLETE, { scanId, candidates: [...byId.values()] });
        }
    }

    function start(scanId) {
        if (typeof scanId !== "string" || !scanId) return;
        if (globalThis[SCANNER_KEY]?.cancel) globalThis[SCANNER_KEY].cancel();
        const controller = {
            listenerInstalled: true,
            scanId,
            cancelled: false,
            cancel: () => { controller.cancelled = true; },
        };
        globalThis[SCANNER_KEY] = controller;
        void discover(scanId, controller).catch(() => {
            if (!isCancelled(scanId, controller)) send(MESSAGE_TYPES.FAILED, { scanId, error: "Unable to inspect this Drive folder." });
        });
    }

    if (!globalThis[SCANNER_KEY]?.listenerInstalled) {
        chrome.runtime.onMessage.addListener((message) => {
            if (message?.type === MESSAGE_TYPES.START) start(message.scanId);
            if (message?.type === MESSAGE_TYPES.CANCEL && message.scanId === globalThis[SCANNER_KEY]?.scanId) {
                globalThis[SCANNER_KEY].cancel();
            }
        });
        globalThis[SCANNER_KEY] = { listenerInstalled: true, scanId: null, cancelled: true, cancel: () => undefined };
    }
})();
