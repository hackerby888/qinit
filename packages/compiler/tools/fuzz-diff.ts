// Differential fuzzer driver for seeded contracts.
import { CORE_PATH } from "../../../test-utils/paths";
import { encodeInput, generate } from "./fuzz-gen";
import { runFuzzer } from "./fuzz-runner";

await runFuzzer({
    corePath: CORE_PATH,
    contractPrefix: "F",
    findingsDirectory: "fuzz-findings",
    tempPrefix: "fuzz",
    generate,
    encodeInput,
});
