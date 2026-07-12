import { CORE_PATH } from "../../../../test-utils/paths";
import { deriveQpiContextLayout } from "../../src/codegen/module";
import { loadQpiHeader } from "../../src/compiler/header";
import { getQpiContext } from "../../src/compiler/qpi-context";

// Low-level framework tests use the same parsed core header and layout engine as contract codegen.
export const QPI_CONTEXT_LAYOUT = deriveQpiContextLayout(getQpiContext(loadQpiHeader(CORE_PATH)).lib);
