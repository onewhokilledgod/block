import initWasm, {
	parseFilterList as parseRaw,
	compileFilterList as compileRaw
} from "./wasm/filter_engine.js";

let initializationPromise;

export function initializeFilterEngine() {
	if (!initializationPromise) {
		initializationPromise = initWasm()
			.then(() => ({
				parseFilterList(input) {
					return parseRaw(input);
				},

				compileFilterList(input, options) {
					return compileRaw(input, options ?? undefined);
				}
			}))
			.catch(error => {
				initializationPromise = undefined;
				throw error;
			});
	}

	return initializationPromise;
}
