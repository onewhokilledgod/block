import type { CosmeticFilter, DomainRestriction } from "../shared/filter-engine.js";

interface CompiledDomainRestriction {
	domain: string;
	include: boolean;
	wildcardTld: boolean;
}

interface CompiledCosmeticFilter {
	selector: string;
	exception: boolean;
	domains: CompiledDomainRestriction[];
}

/**
 * Converts a hostname or domain restriction to its canonical ASCII form.
 *
 * URL performs IDN-to-punycode conversion. Ports, paths and URL components
 * are rejected because cosmetic rules are scoped to hostnames only.
 */
function normalizeHostname(value: string): string | null {
	const candidate = value.trim();

	if (
		candidate.length === 0 ||
		/[/?#@]/.test(candidate) ||
		(!candidate.startsWith("[") && candidate.includes(":"))
	) {
		return null;
	}

	try {
		const url = new URL(`http://${candidate}/`);

		if (
			url.username !== "" ||
			url.password !== "" ||
			url.port !== "" ||
			url.pathname !== "/" ||
			url.search !== "" ||
			url.hash !== ""
		) {
			return null;
		}

		const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

		if (hostname.length === 0 || hostname.length > 253) {
			return null;
		}

		// URL serializes IPv6 hostnames with brackets.
		if (hostname.startsWith("[") && hostname.endsWith("]")) {
			return hostname;
		}

		const labels = hostname.split(".");

		if (
			labels.some(
				label =>
					label.length === 0 ||
					label.length > 63 ||
					!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
			)
		) {
			return null;
		}

		return hostname;
	} catch {
		return null;
	}
}

function compileDomainRestriction(
	restriction: DomainRestriction
): CompiledDomainRestriction | null {
	const rawDomain = restriction.domain.trim().toLowerCase();
	const wildcardTld = rawDomain.endsWith(".*");
	const domainPart = wildcardTld
		? rawDomain.slice(0, -2)
		: rawDomain;

	if (
		domainPart.length === 0 ||
		domainPart.startsWith(".") ||
		domainPart.endsWith(".") ||
		domainPart.includes("..") ||
		(rawDomain.includes("*") && !wildcardTld)
	) {
		return null;
	}

	const domain = normalizeHostname(domainPart);

	if (!domain || (wildcardTld && domain.startsWith("["))) {
		return null;
	}

	return {
		domain,
		include: restriction.include,
		wildcardTld
	};
}

function matchesDomain(
	hostname: string,
	restriction: CompiledDomainRestriction
): boolean {
	if (!restriction.wildcardTld) {
		return (
			hostname === restriction.domain ||
			hostname.endsWith(`.${restriction.domain}`)
		);
	}

	const hostnameLabels = hostname.split(".");
	const domainLabels = restriction.domain.split(".");

	// The wildcard replaces at least one label after the fixed domain.
	// The fixed domain may also occur on a subdomain of the matched host.
	for (
		let start = 0;
		start + domainLabels.length < hostnameLabels.length;
		start += 1
	) {
		const matches = domainLabels.every(
			(label, index) => hostnameLabels[start + index] === label
		);

		if (matches) {
			return true;
		}
	}

	return false;
}

function matchesDomainRestrictions(
	hostname: string,
	restrictions: readonly CompiledDomainRestriction[]
): boolean {
	if (restrictions.length === 0) {
		return true;
	}

	// Exclusions always win, regardless of their position in the list.
	if (
		restrictions.some(
			restriction =>
				!restriction.include && matchesDomain(hostname, restriction)
		)
	) {
		return false;
	}

	const included = restrictions.filter(restriction => restriction.include);

	// A list containing only exclusions applies everywhere else.
	return (
		included.length === 0 ||
		included.some(restriction => matchesDomain(hostname, restriction))
	);
}

/**
 * Resolves parsed ABP cosmetic rules for one page hostname.
 *
 * This class is deliberately DOM-independent. It only decides which CSS
 * selectors are active; selector validation and CSS application belong to
 * later parts of the cosmetic engine.
 */
export class CosmeticRuleEngine {
	private readonly filters: readonly CompiledCosmeticFilter[];

	constructor(filters: readonly CosmeticFilter[]) {
		this.filters = filters.flatMap(filter => {
			const selector = filter.selector.trim();

			if (!selector || !Array.isArray(filter.domains)) {
				return [];
			}

			const domains = filter.domains.map(compileDomainRestriction);

			// Do not apply a partially understood domain scope. Skipping the
			// complete rule is safer than accidentally broadening its reach.
			if (domains.some(domain => domain === null)) {
				return [];
			}

			return [
				{
					selector,
					exception: filter.exception,
					domains: domains as CompiledDomainRestriction[]
				}
			];
		});
	}

	/**
	 * Returns unique selectors active on the supplied hostname.
	 *
	 * An active #@# exception suppresses a hiding rule only when the
	 * selector strings match exactly, as required by ABP semantics.
	 */
	getSelectorsForHostname(hostname: string): string[] {
		const normalizedHostname = normalizeHostname(hostname);

		if (!normalizedHostname) {
			return [];
		}

		const selectors = new Set<string>();
		const exceptions = new Set<string>();

		for (const filter of this.filters) {
			if (
				!matchesDomainRestrictions(
					normalizedHostname,
					filter.domains
				)
			) {
				continue;
			}

			if (filter.exception) {
				exceptions.add(filter.selector);
			} else {
				selectors.add(filter.selector);
			}
		}

		return [...selectors].filter(selector => !exceptions.has(selector));
	}
}
