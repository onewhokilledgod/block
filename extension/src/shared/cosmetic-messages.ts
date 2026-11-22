export const GET_COSMETIC_SELECTORS_MESSAGE =
	"block:get-cosmetic-selectors" as const;
export const APPLY_COSMETIC_CSS_MESSAGE = "block:apply-cosmetic-css" as const;

export interface GetCosmeticSelectorsMessage {
	type: typeof GET_COSMETIC_SELECTORS_MESSAGE;
}

export interface ApplyCosmeticCssMessage {
	type: typeof APPLY_COSMETIC_CSS_MESSAGE;
	cssText: string;
}

export interface CosmeticSelectorsResponse {
	ok: boolean;
	selectors: string[];
	error?: string;
}

export interface ApplyCosmeticCssResponse {
	ok: boolean;
	error?: string;
}

export function isCosmeticSelectorsResponse(
	value: unknown
): value is CosmeticSelectorsResponse {
	if (!value || typeof value !== "object") {
		return false;
	}

	const response = value as Partial<CosmeticSelectorsResponse>;

	return (
		typeof response.ok === "boolean" &&
		Array.isArray(response.selectors) &&
		response.selectors.every(selector => typeof selector === "string")
	);
}

export function isApplyCosmeticCssResponse(
	value: unknown
): value is ApplyCosmeticCssResponse {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as Partial<ApplyCosmeticCssResponse>).ok === "boolean"
	);
}
