import { CORE_PATH } from "../../../../test-utils/paths";
import { deriveQpiContextLayout } from "../../src/backend/wasm/module/library-index";
import { loadQpiHeader } from "../../src/driver/header";
import { getQpiContext } from "../../src/driver/qpi-context";

// Low-level framework tests use the same parsed core header and layout engine as contract codegen.
export const QPI_CONTEXT_LAYOUT = deriveQpiContextLayout(getQpiContext(loadQpiHeader(CORE_PATH)).lib);
