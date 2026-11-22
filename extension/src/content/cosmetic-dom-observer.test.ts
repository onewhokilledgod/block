import { describe, expect, it, vi } from "vitest";

import { CosmeticDomObserver } from "./cosmetic-dom-observer.js";

interface FakeNodeLike {
	nodeType: number;
	childNodes: FakeNode[];
	querySelectorAll?(selector: string): FakeElement[];
}

type FakeNode = FakeElement | FakeShadowRoot;

class FakeStyleSheet {
	cssText = "";

	replaceSync(cssText: string): void {
		if (cssText.includes("INVALID_STYLESHEET")) {
			throw new SyntaxError("Invalid stylesheet");
		}

		this.cssText = cssText;
	}
}

class FakeShadowRoot implements FakeNodeLike {
	readonly nodeType = 11;
	readonly childNodes: FakeNode[] = [];
	adoptedStyleSheets: CSSStyleSheet[] = [];

	appendChild(node: FakeNode): void {
		this.childNodes.push(node);
	}

	querySelectorAll(): FakeElement[] {
		return collectDescendants(this.childNodes);
	}
}

class FakeElement implements FakeNodeLike {
	readonly nodeType = 1;
	readonly childNodes: FakeNode[] = [];
	shadowRoot: FakeShadowRoot | null = null;

	appendChild(node: FakeNode): void {
		this.childNodes.push(node);
	}

	querySelectorAll(): FakeElement[] {
		return collectDescendants(this.childNodes);
	}
}

function collectDescendants(nodes: readonly FakeNode[]): FakeElement[] {
	const elements: FakeElement[] = [];

	for (const node of nodes) {
		if (node instanceof FakeElement) {
			elements.push(node, ...collectDescendants(node.childNodes));
		} else {
			elements.push(...collectDescendants(node.childNodes));
		}
	}

	return elements;
}

class FakeMutationObserver {
	static instances: FakeMutationObserver[] = [];

	readonly observe = vi.fn();
	readonly disconnect = vi.fn();

	constructor(private readonly callback: MutationCallback) {
		FakeMutationObserver.instances.push(this);
	}

	emit(...nodes: FakeNode[]): void {
		this.callback(
			[{ addedNodes: nodes } as unknown as MutationRecord],
			this as unknown as MutationObserver
		);
	}

	static reset(): void {
		FakeMutationObserver.instances = [];
	}
}

function createHarness(options: { maxShadowRoots?: number } = {}) {
	FakeMutationObserver.reset();

	const documentElement = new FakeElement();
	const stylesheet = new FakeStyleSheet();
	const errors: Array<{ message: string; error: unknown }> = [];
	const document = { documentElement } as unknown as Document;

	const observer = new CosmeticDomObserver({
		document,
		maxShadowRoots: options.maxShadowRoots,
		createMutationObserver: callback =>
			new FakeMutationObserver(callback) as unknown as MutationObserver,
		createStyleSheet: () => stylesheet as unknown as CSSStyleSheet,
		onError: (message, error) => errors.push({ message, error })
	});

	return { observer, documentElement, stylesheet, errors };
}

function createHostWithShadowRoot(): {
	host: FakeElement;
	shadowRoot: FakeShadowRoot;
} {
	const host = new FakeElement();
	const shadowRoot = new FakeShadowRoot();
	host.shadowRoot = shadowRoot;
	return { host, shadowRoot };
}

describe("CosmeticDomObserver", () => {
	it("applies the cosmetic stylesheet to existing open shadow roots", () => {
		const { observer, documentElement, stylesheet } = createHarness();
		const { host, shadowRoot } = createHostWithShadowRoot();
		documentElement.appendChild(host);

		observer.start(".ad { display: none !important; }");

		expect(stylesheet.cssText).toBe(".ad { display: none !important; }");
		expect(shadowRoot.adoptedStyleSheets).toEqual([stylesheet]);
		expect(FakeMutationObserver.instances).toHaveLength(2);
	});

	it("finds and styles an open shadow root added after observation starts", () => {
		const { observer, documentElement, stylesheet } = createHarness();
		observer.start(".ad { display: none !important; }");

		const { host, shadowRoot } = createHostWithShadowRoot();
		documentElement.appendChild(host);
		FakeMutationObserver.instances[0]!.emit(host);

		expect(shadowRoot.adoptedStyleSheets).toEqual([stylesheet]);
		expect(FakeMutationObserver.instances).toHaveLength(2);
	});

	it("discovers nested open shadow roots recursively", () => {
		const { observer, documentElement, stylesheet } = createHarness();
		const outer = createHostWithShadowRoot();
		const inner = createHostWithShadowRoot();
		outer.shadowRoot.appendChild(inner.host);
		documentElement.appendChild(outer.host);

		observer.start(".ad { display: none !important; }");

		expect(outer.shadowRoot.adoptedStyleSheets).toEqual([stylesheet]);
		expect(inner.shadowRoot.adoptedStyleSheets).toEqual([stylesheet]);
		expect(FakeMutationObserver.instances).toHaveLength(3);
	});

	it("styles a shadow root inside a node added to an existing shadow tree", () => {
		const { observer, documentElement, stylesheet } = createHarness();
		const outer = createHostWithShadowRoot();
		documentElement.appendChild(outer.host);
		observer.start(".ad { display: none !important; }");

		const inner = createHostWithShadowRoot();
		outer.shadowRoot.appendChild(inner.host);
		FakeMutationObserver.instances[1]!.emit(inner.host);

		expect(inner.shadowRoot.adoptedStyleSheets).toEqual([stylesheet]);
		expect(FakeMutationObserver.instances).toHaveLength(3);
	});

	it("does not add the same stylesheet or observers twice", () => {
		const { observer, documentElement, stylesheet } = createHarness();
		const { host, shadowRoot } = createHostWithShadowRoot();
		documentElement.appendChild(host);

		observer.start(".ad { display: none !important; }");
		observer.start(".ad { display: none !important; }");
		FakeMutationObserver.instances[0]!.emit(host);

		expect(shadowRoot.adoptedStyleSheets).toEqual([stylesheet]);
		expect(FakeMutationObserver.instances).toHaveLength(2);
	});

	it("preserves stylesheets owned by the page when stopped", () => {
		const { observer, documentElement, stylesheet } = createHarness();
		const { host, shadowRoot } = createHostWithShadowRoot();
		const pageStylesheet = new FakeStyleSheet() as unknown as CSSStyleSheet;
		shadowRoot.adoptedStyleSheets = [pageStylesheet];
		documentElement.appendChild(host);

		observer.start(".ad { display: none !important; }");
		observer.stop();

		expect(shadowRoot.adoptedStyleSheets).toEqual([pageStylesheet]);
		expect(FakeMutationObserver.instances.every(item => item.disconnect.mock.calls.length === 1)).toBe(true);
		expect(shadowRoot.adoptedStyleSheets).not.toContain(stylesheet);
	});

	it("does not inspect closed shadow roots", () => {
		const { observer, documentElement } = createHarness();
		const closedHost = new FakeElement();
		closedHost.shadowRoot = null;
		documentElement.appendChild(closedHost);

		observer.start(".ad { display: none !important; }");

		expect(FakeMutationObserver.instances).toHaveLength(1);
	});

	it("enforces the configured open shadow root limit", () => {
		const { observer, documentElement, errors } = createHarness({ maxShadowRoots: 1 });
		const first = createHostWithShadowRoot();
		const second = createHostWithShadowRoot();
		documentElement.appendChild(first.host);
		documentElement.appendChild(second.host);

		observer.start(".ad { display: none !important; }");

		expect(first.shadowRoot.adoptedStyleSheets).toHaveLength(1);
		expect(second.shadowRoot.adoptedStyleSheets).toHaveLength(0);
		expect(errors).toHaveLength(1);
	});

	it("rolls back when the stylesheet cannot be parsed", () => {
		const { observer } = createHarness();

		expect(() => observer.start("INVALID_STYLESHEET")).toThrow(SyntaxError);
		expect(FakeMutationObserver.instances).toHaveLength(0);
	});

	it("allows an empty stylesheet without creating observers", () => {
		const { observer } = createHarness();

		observer.start("  ");

		expect(FakeMutationObserver.instances).toHaveLength(0);
	});

	it("rejects an invalid shadow root limit", () => {
		expect(() => createHarness({ maxShadowRoots: -1 })).toThrow(RangeError);
		expect(() => createHarness({ maxShadowRoots: 1.5 })).toThrow(RangeError);
	});
});
