export interface BrowserAlarm {
	name: string;
	periodInMinutes?: number;
}

export interface AlarmCreateInfo {
	periodInMinutes: number;
}

export interface BrowserAlarmsApi {
	get(name: string): Promise<BrowserAlarm | undefined>;

	create(name: string, alarmInfo: AlarmCreateInfo): void | Promise<void>;

	onAlarm: {
		addListener(listener: (alarm: BrowserAlarm) => void): void;
	};
}

export interface BrowserRuntimeLifecycleApi {
	onInstalled: {
		addListener(listener: () => void): void;
	};

	onStartup: {
		addListener(listener: () => void): void;
	};
}

export interface BrowserLifecycleApi {
	alarms: BrowserAlarmsApi;
	runtime: BrowserRuntimeLifecycleApi;
}

interface ExtensionApiNamespace {
	alarms?: BrowserAlarmsApi;
	runtime?: BrowserRuntimeLifecycleApi;
}

interface ExtensionGlobals {
	browser?: ExtensionApiNamespace;
	chrome?: ExtensionApiNamespace;
}

export function getBrowserLifecycleApi(): BrowserLifecycleApi {
	const globals = globalThis as typeof globalThis & ExtensionGlobals;

	const namespace = globals.browser ?? globals.chrome;

	const alarms = namespace?.alarms;
	const runtime = namespace?.runtime;

	if (!alarms || !runtime) {
		throw new Error(
			"Browser lifecycle API is unavailable. " +
				"Check the extension manifest and permissions."
		);
	}

	return {
		alarms,
		runtime
	};
}
