/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ExtensionManifest {
	declarative_net_request?: {
		rule_resources?: Array<{
			id: string;
			enabled: boolean;
			path: string;
		}>;
	};
}

const manifest = JSON.parse(
	readFileSync(new URL("../../public/manifest.json", import.meta.url), "utf8")
) as ExtensionManifest;

describe("DNR startup compatibility", () => {
	it("declares an enabled empty static bootstrap ruleset", () => {
		const ruleset = manifest.declarative_net_request?.rule_resources?.find(
			item => item.id === "startup_compatibility"
		);

		expect(ruleset).toEqual({
			id: "startup_compatibility",
			enabled: true,
			path: "rules/startup-compatibility.json"
		});

		const contents = JSON.parse(
			readFileSync(
				new URL("../../public/rules/startup-compatibility.json", import.meta.url),
				"utf8"
			)
		);

		expect(contents).toEqual([]);
	});
});
