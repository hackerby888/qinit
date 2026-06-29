// Simplified function-scaffolding macros, prepended to the USER source (override the real qpi.h
// macros for the user-code parse only). They expand the contract's PUBLIC_FUNCTION / PUBLIC_PROCEDURE
// / REGISTER_* / lifecycle macros into the predictable shape codegen's extractRegistrations + emitFunction
// expect. The real qpi.h is still parsed (separately) for container/type layouts — these only affect
// how the user's own functions are scaffolded, which the real macros' guard objects don't change.
export const SCAFFOLD_MACROS = `
#undef INITIALIZE
#undef BEGIN_EPOCH
#undef END_EPOCH
#undef BEGIN_TICK
#undef END_TICK
#undef PRE_ACQUIRE_SHARES
#undef POST_ACQUIRE_SHARES
#undef PRE_RELEASE_SHARES
#undef POST_RELEASE_SHARES
#undef POST_INCOMING_TRANSFER
#undef PUBLIC_FUNCTION
#undef PUBLIC_PROCEDURE
#undef PUBLIC_FUNCTION_WITH_LOCALS
#undef PUBLIC_PROCEDURE_WITH_LOCALS
#undef PRIVATE_FUNCTION
#undef PRIVATE_PROCEDURE
#undef PRIVATE_FUNCTION_WITH_LOCALS
#undef PRIVATE_PROCEDURE_WITH_LOCALS
#undef REGISTER_USER_FUNCTIONS_AND_PROCEDURES
#undef REGISTER_USER_FUNCTION
#undef REGISTER_USER_PROCEDURE
#undef LOG_INFO
#undef LOG_ERROR
#undef LOG_WARNING
#undef LOG_DEBUG

#undef INITIALIZE_WITH_LOCALS
#undef BEGIN_EPOCH_WITH_LOCALS
#undef END_EPOCH_WITH_LOCALS
#undef BEGIN_TICK_WITH_LOCALS
#undef END_TICK_WITH_LOCALS
#undef PRE_ACQUIRE_SHARES_WITH_LOCALS
#undef POST_ACQUIRE_SHARES_WITH_LOCALS
#undef PRE_RELEASE_SHARES_WITH_LOCALS
#undef POST_RELEASE_SHARES_WITH_LOCALS
#undef POST_INCOMING_TRANSFER_WITH_LOCALS
#undef SET_SHAREHOLDER_PROPOSAL
#undef SET_SHAREHOLDER_VOTES
#undef SET_SHAREHOLDER_PROPOSAL_WITH_LOCALS
#undef SET_SHAREHOLDER_VOTES_WITH_LOCALS
#undef EXPAND

#define INITIALIZE() static void __impl_initialize(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define BEGIN_EPOCH() static void __impl_beginEpoch(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define END_EPOCH() static void __impl_endEpoch(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define BEGIN_TICK() static void __impl_beginTick(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define END_TICK() static void __impl_endTick(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define INITIALIZE_WITH_LOCALS() static void __impl_initialize(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define BEGIN_EPOCH_WITH_LOCALS() static void __impl_beginEpoch(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define END_EPOCH_WITH_LOCALS() static void __impl_endEpoch(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define BEGIN_TICK_WITH_LOCALS() static void __impl_beginTick(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define END_TICK_WITH_LOCALS() static void __impl_endTick(const QpiContextProcedureCall& qpi, void* state, NoData& input, NoData& output, void* locals)
#define PRE_ACQUIRE_SHARES() static void __impl_preAcquireShares(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define POST_ACQUIRE_SHARES() static void __impl_postAcquireShares(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define PRE_RELEASE_SHARES() static void __impl_preReleaseShares(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define POST_RELEASE_SHARES() static void __impl_postReleaseShares(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define POST_INCOMING_TRANSFER() static void __impl_postIncomingTransfer(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define PRE_ACQUIRE_SHARES_WITH_LOCALS() static void __impl_preAcquireShares(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define POST_ACQUIRE_SHARES_WITH_LOCALS() static void __impl_postAcquireShares(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define PRE_RELEASE_SHARES_WITH_LOCALS() static void __impl_preReleaseShares(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define POST_RELEASE_SHARES_WITH_LOCALS() static void __impl_postReleaseShares(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define POST_INCOMING_TRANSFER_WITH_LOCALS() static void __impl_postIncomingTransfer(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define SET_SHAREHOLDER_PROPOSAL() static void __impl_setShareholderProposal(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define SET_SHAREHOLDER_VOTES() static void __impl_setShareholderVotes(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define SET_SHAREHOLDER_PROPOSAL_WITH_LOCALS() static void __impl_setShareholderProposal(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)
#define SET_SHAREHOLDER_VOTES_WITH_LOCALS() static void __impl_setShareholderVotes(const QpiContextProcedureCall& qpi, void* state, void* input, void* output, void* locals)

#define PUBLIC_FUNCTION(f) static void f(const QpiContextFunctionCall& qpi, void* state, f##_input& input, f##_output& output, f##_locals& locals)
#define PUBLIC_PROCEDURE(p) static void p(const QpiContextProcedureCall& qpi, void* state, p##_input& input, p##_output& output, p##_locals& locals)
#define PUBLIC_FUNCTION_WITH_LOCALS(f) static void f(const QpiContextFunctionCall& qpi, void* state, f##_input& input, f##_output& output, f##_locals& locals)
#define PUBLIC_PROCEDURE_WITH_LOCALS(p) static void p(const QpiContextProcedureCall& qpi, void* state, p##_input& input, p##_output& output, p##_locals& locals)
#define PRIVATE_FUNCTION(f) static void f(const QpiContextFunctionCall& qpi, void* state, f##_input& input, f##_output& output, f##_locals& locals)
#define PRIVATE_PROCEDURE(p) static void p(const QpiContextProcedureCall& qpi, void* state, p##_input& input, p##_output& output, p##_locals& locals)
#define PRIVATE_FUNCTION_WITH_LOCALS(f) static void f(const QpiContextFunctionCall& qpi, void* state, f##_input& input, f##_output& output, f##_locals& locals)
#define PRIVATE_PROCEDURE_WITH_LOCALS(p) static void p(const QpiContextProcedureCall& qpi, void* state, p##_input& input, p##_output& output, p##_locals& locals)

#define REGISTER_USER_FUNCTIONS_AND_PROCEDURES() static void __registerUserFunctionsAndProcedures(const QpiContextForInit& qpi)
#define REGISTER_USER_FUNCTION(f, it) qpi.__registerUserFunction((void*)f, it, sizeof(f##_input), sizeof(f##_output), sizeof(f##_locals));
#define REGISTER_USER_PROCEDURE(p, it) qpi.__registerUserProcedure((void*)p, it, sizeof(p##_input), sizeof(p##_output), sizeof(p##_locals));

#define LOG_INFO(m)
#define LOG_ERROR(m)
#define LOG_WARNING(m)
#define LOG_DEBUG(m)

#undef CALL
#undef CALL_OTHER_CONTRACT_FUNCTION
#undef INVOKE_OTHER_CONTRACT_PROCEDURE
#define CALL(f, in, out) __qpi_call_self(f, in, out)
#define CALL_OTHER_CONTRACT_FUNCTION(c, f, in, out) __qpi_call_other(c, f, in, out)
#define INVOKE_OTHER_CONTRACT_PROCEDURE(c, p, in, out, reward) __qpi_invoke_other(c, p, in, out, reward)
`;
