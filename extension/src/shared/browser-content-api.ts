export interface BrowserTab {
	id?: number;
	url?: string;
}

export interface BrowserMessageSender {
	id?: string;
	url?: string;
	frameId?: number;
	tab?: BrowserTab;
}

export type RuntimeMessageListener = (
	message: unknown,
	sender: BrowserMessageSender,
	sendResponse: (response: unknown) => void
) => boolean | void;

export interface BrowserRuntimeApi {
	sendMessage(message: unknown): Promise<unknown>;
	onMessage: {
		addListener(listener: RuntimeMessageListener): void;
	};
}

export interface BrowserPermissionsApi {
	request(permissions: { origins?: string[] }): Promise<boolean>;
	contains(permissions: { origins?: string[] }): Promise<boolean>;
}

export interface RegisteredContentScript {
	id: string;
	matches: string[];
	js: string[];
	runAt: "document_start" | "document_end" | "document_idle";
	persistAcrossSessions?: boolean;
	allFrames?: boolean;
}

export interface BrowserScriptingApi {
	getRegisteredContentScripts(filter?: {
		ids?: string[];
	}): Promise<RegisteredContentScript[]>;

	registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;

	updateContentScripts(
		scripts: Array<Pick<RegisteredContentScript, "id"> & Partial<RegisteredContentScript>>
	): Promise<void>;

	executeScript(details: {
		target: { tabId: number; frameIds?: number[] };
		files: string[];
	}): Promise<unknown[]>;

	insertCSS(details: {
		target: { tabId: number; frameIds?: number[] };
		css: string;
		origin?: "AUTHOR" | "USER";
	}): Promise<void>;
}

export interface BrowserTabsApi {
	query(queryInfo: {
		active?: boolean;
		currentWindow?: boolean;
	}): Promise<BrowserTab[]>;
}

export interface BrowserContentApi {
	runtime: BrowserRuntimeApi;
	permissions: BrowserPermissionsApi;
	scripting: BrowserScriptingApi;
	tabs: BrowserTabsApi;
}

interface ExtensionApiNamespace {
	runtime?: BrowserRuntimeApi;
	permissions?: BrowserPermissionsApi;
	scripting?: BrowserScriptingApi;
	tabs?: BrowserTabsApi;
}

interface ExtensionGlobals {
	browser?: ExtensionApiNamespace;
	chrome?: ExtensionApiNamespace;
}

function getExtensionNamespace(): ExtensionApiNamespace {
	const globals = globalThis as typeof globalThis & ExtensionGlobals;
	const namespace = globals.browser ?? globals.chrome;

	if (!namespace) {
		throw new Error("WebExtension API namespace is unavailable.");
	}

	return namespace;
}

/**
 * Returns only the runtime messaging API.
 *
 * Content scripts do not have access to every privileged extension API, so
 * they must not use getBrowserContentApi().
 */
export function getBrowserRuntimeApi(): BrowserRuntimeApi {
	const runtime = getExtensionNamespace().runtime;

	if (!runtime) {
		throw new Error("Browser runtime messaging API is unavailable.");
	}

	return runtime;
}

/** Returns the privileged APIs used by the popup and background worker. */
export function getBrowserContentApi(): BrowserContentApi {
	const namespace = getExtensionNamespace();
	const { runtime, permissions, scripting, tabs } = namespace;

	if (!runtime || !permissions || !scripting || !tabs) {
		throw new Error(
			"Cosmetic content APIs are unavailable. " +
				"Check the extension manifest and browser version."
		);
	}

	return { runtime, permissions, scripting, tabs };
}
