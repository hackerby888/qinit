import { compileContract, loadQpiHeader } from "../packages/compile/src/index";
import { CORE_PATH } from "../test-utils/paths";

const HEADER = loadQpiHeader(CORE_PATH);
const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct In_input { uint16 x; };
  struct In_output { uint16 y; };
  PUBLIC_FUNCTION(In) { output.y = ProposalTypes::cls(input.x); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
};
`;
const result = await compileContract({
  source,
  name: "NsProbe",
  slot: 42,
  qpiHeader: HEADER,
});
console.log(
  result.diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`),
);
