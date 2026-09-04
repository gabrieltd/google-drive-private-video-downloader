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
    const GOOGLE_NATIVE_MIME_PREFIX = "application/vnd.google-apps.";
    const RESERVED_ID_PREFIXES = /^(?:row|menu|item)[-_]/i;

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
        return !/^\d+$/.test(id) && !RESERVED_ID_PREFIXES.test(id);
    }

    function isLikelyVideoFilename(value) {
        const match = normalizedText(value).match(/\.([a-z0-9]{2,8})$/i);
        return Boolean(match && VIDEO_EXTENSIONS.has(match[1].toLowerCase()));
    }

    function isLikelyFilename(value) {
        const name = normalizedText(value);
        return name.length > 0 && name.length <= 240 && !/^[|·•-]+$/.test(name);
    }

    function isMetadataText(value) {
        return /\b(owner|modified|size|date|shared|location|last opened|created)\b/i.test(value)
            && !/\.[a-z0-9]{2,8}$/i.test(value);
    }

    function isGenericFolderLabel(value) {
        return /^(?:folder path|folders and views|name|owner|date modified|file size)$/i.test(value);
    }

    function isDriveFolderHref(value) {
        if (typeof value !== "string") return false;
        try {
            const url = new URL(value, window.location.href);
            return url.protocol === "https:"
                && url.hostname === "drive.google.com"
                && /(?:^|\/)folders\/[A-Za-z0-9_-]+(?:\/|$)/.test(url.pathname);
        } catch {
            return false;
        }
    }

    function idFromHref(value) {
        if (typeof value !== "string") return null;
        try {
            const url = new URL(value, window.location.href);
            if (url.protocol !== "https:" || url.hostname !== "drive.google.com") return null;
            const pathMatch = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
            if (pathMatch && isValidFileId(pathMatch[1])) return pathMatch[1];
            const queryId = url.searchParams.get("id");
            return isValidFileId(queryId) ? queryId : null;
        } catch {
            return null;
        }
    }

    function itemRoot(element) {
        return element.closest("[role='row'], [role='gridcell'], [role='listitem'], [data-file-id], [data-target-id]") ?? element;
    }

    function attributeValues(element, attributes) {
        const root = itemRoot(element);
        const values = [];
        for (const node of [element, root]) {
            for (const attribute of attributes) values.push(node.getAttribute(attribute));
        }
        for (const node of root.querySelectorAll("[data-mime-type], [data-type], [data-file-type]")) {
            for (const attribute of attributes) values.push(node.getAttribute(attribute));
        }
        return values.map(normalizedText).filter(Boolean);
    }

    function mimeTypeFromElement(element) {
        const values = attributeValues(element, ["data-mime-type", "data-type", "data-file-type"]);
        return values.find((value) => /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value))?.toLowerCase() ?? "";
    }

    function isFolderElement(element) {
        const mimeType = mimeTypeFromElement(element);
        if (mimeType === "application/vnd.google-apps.folder") return true;

        const root = itemRoot(element);
        const typeValues = attributeValues(element, ["data-type", "data-mime-type", "data-target"])
            .map((value) => value.toLowerCase());
        if (typeValues.some((value) => value === "folder" || value.endsWith("/folder"))) return true;

        const iconTitles = [...root.querySelectorAll("svg title")]
            .map((node) => normalizedText(node.textContent).toLowerCase());
        if (iconTitles.includes("folder")) return true;

        const anchor = root.querySelector("a[href]") ?? (root.matches("a[href]") ? root : null);
        return Boolean(anchor && isDriveFolderHref(anchor.getAttribute("href")));
    }

    function idFromElement(element) {
        const root = itemRoot(element);
        const href = root.matches("a[href]") ? root.getAttribute("href") : root.querySelector("a[href]")?.getAttribute("href");
        const hrefId = idFromHref(href);
        if (hrefId) return hrefId;

        const attributes = ["data-file-id", "data-target-id"];
        if (["row", "gridcell", "listitem"].includes(root.getAttribute("role"))) attributes.push("data-id");
        for (const attribute of attributes) {
            const value = root.getAttribute(attribute);
            if (isValidFileId(value)) return value.trim();
        }
        return null;
    }

    function hasFileEvidence(element) {
        const root = itemRoot(element);
        const href = root.matches("a[href]") ? root.getAttribute("href") : root.querySelector("a[href]")?.getAttribute("href");
        if (idFromHref(href)) return true;
        if (root.getAttribute("data-file-id") || root.getAttribute("data-target-id")) return true;
        return ["row", "gridcell", "listitem"].includes(root.getAttribute("role"))
            && isValidFileId(root.getAttribute("data-id"));
    }

    function textCandidates(element) {
        const root = itemRoot(element);
        const values = [];
        const add = (value) => {
            const normalized = normalizedText(value);
            if (normalized && !values.includes(normalized)) values.push(normalized);
        };

        const anchors = [
            ...(root.matches("a[href]") ? [root] : []),
            ...root.querySelectorAll("a[href]"),
        ];
        for (const node of anchors) {
            if (!idFromHref(node.getAttribute("href"))) continue;
            add(node.textContent);
            add(node.getAttribute("data-tooltip"));
            add(node.getAttribute("title"));
            add(node.getAttribute("aria-label"));
        }

        for (const node of root.querySelectorAll("strong")) add(node.textContent);

        for (const node of [element, root, ...root.querySelectorAll("[data-tooltip], [title], [aria-label]")]) {
            add(node.getAttribute("data-tooltip"));
            add(node.getAttribute("title"));
            add(node.getAttribute("aria-label"));
        }
        add(element.textContent);
        add(root.textContent);
        return values;
    }

    function nameFromElement(element, isVideo) {
        const values = textCandidates(element);
        const descriptive = values.find((value) => isLikelyFilename(value) && !isMetadataText(value));
        if (descriptive) return descriptive;
        return isVideo ? "Untitled video" : "Untitled file";
    }

    function semanticMetadata(element) {
        const root = itemRoot(element);
        const mimeType = mimeTypeFromElement(element);
        const ariaLabel = [root.getAttribute("aria-label"), element.getAttribute("aria-label")]
            .filter(Boolean)
            .join(" ");
        return {
            mimeType,
            ariaLabel,
            type: root.getAttribute("data-type") ?? "",
        };
    }

    function isGoogleNativeMimeType(mimeType) {
        return mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX);
    }

    function classifyElement(element) {
        if (!hasFileEvidence(element) || isFolderElement(element)) return null;
        const fileId = idFromElement(element);
        if (!fileId) return null;

        const metadata = semanticMetadata(element);
        const provisionalName = nameFromElement(element, false);
        const isVideo = /^video\//i.test(metadata.mimeType)
            || metadata.type.toLowerCase() === "video"
            || isLikelyVideoFilename(provisionalName)
            || /\bvideo\b/i.test(metadata.ariaLabel);
        const name = nameFromElement(element, isVideo);
        const url = `https://drive.google.com/file/d/${fileId}/view`;

        if (isGoogleNativeMimeType(metadata.mimeType)) {
            return {
                fileId,
                name,
                mimeType: metadata.mimeType,
                url,
                kind: "unsupported",
                error: "Google-native documents require export and are not supported by this version.",
            };
        }
        if (isVideo) {
            return {
                fileId,
                name: name === "Untitled file" ? "Untitled video" : name,
                url,
                isVideo: true,
                status: "pending",
                attempts: 0,
                videoId: null,
                error: null,
            };
        }
        return {
            fileId,
            name,
            mimeType: metadata.mimeType || "application/octet-stream",
            url,
            kind: "file",
        };
    }

    function collectItems(root) {
        const elements = [root, ...root.querySelectorAll(
            "a[href], [data-file-id], [data-target-id], [data-id], [role='row'], [role='gridcell'], [role='listitem']",
        )];
        const byId = new Map();
        for (const element of elements) {
            const item = classifyElement(element);
            if (!item) continue;
            const existing = byId.get(item.fileId);
            if (!existing || item.kind === "video") byId.set(item.fileId, item);
        }
        return [...byId.values()];
    }

    function summarizeItems(items) {
        return {
            discoveredCount: items.length,
            discoveredVideoCount: items.filter((item) => item.isVideo === true).length,
            discoveredRegularFileCount: items.filter((item) => item.kind === "file").length,
            discoveredUnsupportedCount: items.filter((item) => item.kind === "unsupported").length,
        };
    }

    function folderNameFromPage() {
        const candidateGroups = [
            document.querySelectorAll("[role='list'][aria-label*='folder path' i] [role='button'][aria-label]"),
            document.querySelectorAll("[aria-label*='breadcrumb' i] [aria-current], [aria-current='page']"),
            document.querySelectorAll("[role='heading']"),
        ];
        for (const candidates of candidateGroups) {
            for (const element of candidates) {
                const name = normalizedText(element.getAttribute("aria-label")) || normalizedText(element.textContent);
                if (name && !/google drive/i.test(name) && !isGenericFolderLabel(name) && isLikelyVideoFilename(name) === false) return name;
            }
        }

        const title = normalizedText(document.title).replace(/\s*-\s*Google Drive\s*$/i, "");
        return title || "Google Drive Folder";
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
            const candidateCount = collectItems(element).length;
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
            const summary = summarizeItems([...byId.values()]);
            if (!force && byId.size === lastReportedCount) return;
            lastReportedCount = byId.size;
            send(MESSAGE_TYPES.PROGRESS, { scanId, ...summary });
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
                for (const item of collectItems(root)) {
                    const existing = byId.get(item.fileId);
                    if (!existing || item.kind === "video") byId.set(item.fileId, item);
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
            const items = [...byId.values()];
            const summary = summarizeItems(items);
            reportProgress(true);
            send(MESSAGE_TYPES.COMPLETE, {
                scanId,
                folderName: folderNameFromPage(),
                candidates: items.filter((item) => item.isVideo === true),
                regularFiles: items.filter((item) => item.kind === "file"),
                unsupportedFiles: items.filter((item) => item.kind === "unsupported"),
                ...summary,
            });
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
