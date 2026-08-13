// Differential fuzzer for the `uint128` grammar.
import { CORE_PATH } from "../../../test-utils/paths";
import { encodeInput, generate } from "./fuzz-gen-u128";
import { runFuzzer } from "./fuzz-runner";

await runFuzzer({
    corePath: CORE_PATH,
    contractPrefix: "U",
    findingsDirectory: "fuzz-findings-u128",
    tempPrefix: "fuzz128",
    generate,
    encodeInput,
});
