import initWasm, {
	parseFilterList as parseRaw,
	compileFilterList as compileRaw,
	compileFilterLists as compileRawLists
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
				},

				compileFilterLists(inputs) {
					return compileRawLists(inputs);
				}
			}))
			.catch(error => {
				initializationPromise = undefined;
				throw error;
			});
	}

	return initializationPromise;
}
