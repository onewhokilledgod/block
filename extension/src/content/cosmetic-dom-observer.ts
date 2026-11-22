/**
 * Applies cosmetic CSS to dynamically created open Shadow DOM trees.
 *
 * Ordinary document elements do not need MutationObserver handling: once the
 * browser stylesheet has been installed, the browser's CSS engine applies it
 * automatically to elements inserted later. This observer is intentionally
 * limited to open shadow roots, which are separate style scopes.
 *
 * Closed shadow roots cannot be inspected or styled from an extension content
 * script and are deliberately left untouched.
 */

const DEFAULT_MAX_SHADOW_ROOTS = 1_000;

export interface CosmeticDomObserverOptions {
	/** Injectable for tests; production uses the current page document. */
	document?: Document;
	/** Injectable for tests; production uses the browser MutationObserver. */
	createMutationObserver?: (callback: MutationCallback) => MutationObserver;
	/** Injectable for tests; production uses constructable CSSStyleSheet. */
	createStyleSheet?: () => CSSStyleSheet;
	/** Maximum number of open shadow roots styled by one document instance. */
	maxShadowRoots?: number;
	onError?: (message: string, error: unknown) => void;
}

function readMaxShadowRoots(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_MAX_SHADOW_ROOTS;
	}

	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError("maxShadowRoots must be a non-negative safe integer.");
	}

	return value;
}

export class CosmeticDomObserver {
	private readonly document: Document;
	private readonly createMutationObserver: (
		callback: MutationCallback
	) => MutationObserver;
	private readonly createStyleSheet: () => CSSStyleSheet;
	private readonly maxShadowRoots: number;
	private readonly onError: (message: string, error: unknown) => void;

	private stylesheet?: CSSStyleSheet;
	private started = false;
	private observedShadowRoots = new WeakSet<ShadowRoot>();
	private readonly shadowRoots = new Set<ShadowRoot>();
	private readonly observers = new Set<MutationObserver>();

	constructor(options: CosmeticDomObserverOptions = {}) {
		this.document = options.document ?? document;
		this.createMutationObserver =
			options.createMutationObserver ??
			(callback => new MutationObserver(callback));
		this.createStyleSheet =
			options.createStyleSheet ?? (() => new CSSStyleSheet());
		this.maxShadowRoots = readMaxShadowRoots(options.maxShadowRoots);
		this.onError =
			options.onError ??
			((message, error) => console.warn(`[Block] ${message}`, error));
	}

	/**
	 * Starts observing the document and styles existing and future open shadow
	 * roots. Calling start more than once is safe.
	 */
	start(cssText: string): void {
		if (this.started || cssText.trim().length === 0) {
			return;
		}

		const documentElement = this.document.documentElement;
		if (!documentElement) {
			throw new Error("Cannot observe a document without a document element.");
		}

		const stylesheet = this.createStyleSheet();
		if (typeof stylesheet.replaceSync !== "function") {
			throw new Error("Constructable stylesheets are unavailable.");
		}

		// Parse the stylesheet once. A parse error must not leave a partially
		// active observer or a half-installed style sheet.
		stylesheet.replaceSync(cssText);
		this.stylesheet = stylesheet;
		this.started = true;

		try {
			this.observe(documentElement);
			this.scanForOpenShadowRoots(documentElement);
		} catch (error: unknown) {
			this.stop();
			throw error;
		}
	}

	/** Disconnects observers and removes this module's sheet from styled roots. */
	stop(): void {
		for (const observer of this.observers) {
			observer.disconnect();
		}
		this.observers.clear();

		const stylesheet = this.stylesheet;
		if (stylesheet) {
			for (const root of this.shadowRoots) {
				try {
					root.adoptedStyleSheets = Array.from(root.adoptedStyleSheets).filter(
						sheet => sheet !== stylesheet
					);
				} catch (error: unknown) {
					this.onError("Could not remove cosmetic styles from a shadow root.", error);
				}
			}
		}

		this.shadowRoots.clear();
		this.observedShadowRoots = new WeakSet<ShadowRoot>();
		this.stylesheet = undefined;
		this.started = false;
	}

	private observe(target: Node): void {
		const observer = this.createMutationObserver(records => {
			if (!this.started) {
				return;
			}

			for (const record of records) {
				for (const node of Array.from(record.addedNodes)) {
					this.scanForOpenShadowRoots(node);
				}
			}
		});

		observer.observe(target, { childList: true, subtree: true });
		this.observers.add(observer);
	}

	private scanForOpenShadowRoots(node: Node): void {
		const elements: Element[] = [];

		if (node.nodeType === 1) {
			elements.push(node as Element);
		}

		// querySelectorAll also works on DocumentFragments and ShadowRoots.
		const querySelectorAll = (node as ParentNode).querySelectorAll;
		if (typeof querySelectorAll === "function") {
			elements.push(...Array.from(querySelectorAll.call(node, "*")));
		}

		for (const element of elements) {
			const shadowRoot = element.shadowRoot;
			if (shadowRoot) {
				this.attachShadowRoot(shadowRoot);
			}
		}
	}

	private attachShadowRoot(root: ShadowRoot): void {
		if (this.observedShadowRoots.has(root)) {
			return;
		}

		if (this.shadowRoots.size >= this.maxShadowRoots) {
			this.onError(
				`The open Shadow DOM limit (${this.maxShadowRoots}) was reached; additional roots were skipped.`,
				new RangeError("Maximum cosmetic Shadow DOM roots exceeded.")
			);
			return;
		}

		this.observedShadowRoots.add(root);
		this.shadowRoots.add(root);

		const stylesheet = this.stylesheet;
		if (!stylesheet) {
			return;
		}

		try {
			const adopted = Array.from(root.adoptedStyleSheets);
			if (!adopted.includes(stylesheet)) {
				root.adoptedStyleSheets = [...adopted, stylesheet];
			}
		} catch (error: unknown) {
			this.onError("Could not adopt cosmetic styles into an open shadow root.", error);
		}

		// Observe each shadow root separately because mutations inside it do not
		// appear in the document's MutationObserver records.
		try {
			this.observe(root);
		} catch (error: unknown) {
			this.onError("Could not observe an open shadow root.", error);
		}

		// Discover shadow hosts nested inside this shadow tree.
		this.scanForOpenShadowRoots(root);
	}
}
