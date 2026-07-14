import type { FunctionLoweringServices } from "./function-lowering-contract";
import { registerFunctionLoweringServices } from "./function-lowering-registry";
import { aggOperand, emitValue, lowerValueExpression } from "../expressions/value-expression";
import { allocateScratchSlot, allocateScratchSlotNode, argAddr, isAggregate, setLocal } from "../memory/memory-operations";
import { emitConstruct, resolveContainerElem } from "../memory/construction";
import { collectFunctionLocals } from "./local-collector";
import { emitStatement } from "../statements/statement-emitter";
import { allocateTemporaryLocalName, emitArrayInitializer, emitHelperFunction } from "./function-emitter";
import { resolveExpressionAddress, resolveLvalue } from "../memory/address-resolution";
import { promoteInfo, scalarTypeInfo, usualConversion } from "../expressions/conversions";
import { emitU128, isU128Expr, lowerUint128Expression, sourceU128Result } from "../expressions/uint128";
import { emitQpiCall, materializeAssetAddress, materializeSelect } from "../calls/qpi";
import { emitAggHelperCall, emitHelperCall, lookupHelper, pickHelperOverload } from "../calls/library-call";
import { emitProposalProxyAddr, emitProposalProxyCall, emitProxySiblingCall } from "../calls/proxy";
import { callCompiled, emitAssetIter, emitContainerCall, emitTemplateContainerCall } from "../calls/containers";
import { emitAddress } from "../memory/address-emitter";
import { emitInlineStructMethod, emitInlineStructStatement, emitInlineStructValue, inlineMethodInfo, tryInlineStructMethod } from "./inline-struct-methods";
import { emitCallValueIr } from "../calls/value-call";
import { emitInterContract } from "../calls/inter-contract";
import { emitThisCall } from "../calls/this-call";
import { compileLibraryFunctionInstance, selectLibraryFunctionOverload } from "../calls/library-function-compiler";
import { emitDiscardedExpression, emitIncrementOrDecrement, isScalarLocal } from "../expressions/discarded-expression";
import { lowerBinaryExpression } from "../expressions/binary-expression";
import { emitAssign, narrowLocalValue, newValueTmp } from "../expressions/assignment";
import { emitCallStatement } from "../calls/statement-call";
import { emitCompound, emitScratchpadReleases } from "../statements/compound-emitter";

export const FUNCTION_LOWERING_SERVICES: FunctionLoweringServices = {
  aggOperand,
  allocateScratchSlot,
  allocateScratchSlotNode,
  allocateTemporaryLocalName,
  argAddr,
  callCompiled,
  collectFunctionLocals,
  compileLibraryFunctionInstance,
  emitAddress,
  emitAggHelperCall,
  emitArrayInitializer,
  emitAssetIter,
  emitAssign,
  emitCallStatement,
  emitCallValueIr,
  emitCompound,
  emitConstruct,
  emitContainerCall,
  emitDiscardedExpression,
  emitHelperCall,
  emitHelperFunction,
  emitIncrementOrDecrement,
  emitInlineStructMethod,
  emitInlineStructStatement,
  emitInlineStructValue,
  emitInterContract,
  emitProposalProxyAddr,
  emitProposalProxyCall,
  emitProxySiblingCall,
  emitQpiCall,
  emitScratchpadReleases,
  emitStatement,
  emitTemplateContainerCall,
  emitThisCall,
  emitU128,
  emitValue,
  inlineMethodInfo,
  isAggregate,
  isScalarLocal,
  isU128Expr,
  lookupHelper,
  lowerBinaryExpression,
  lowerUint128Expression,
  lowerValueExpression,
  materializeAssetAddress,
  materializeSelect,
  narrowLocalValue,
  newValueTmp,
  pickHelperOverload,
  promoteInfo,
  resolveContainerElem,
  resolveExpressionAddress,
  resolveLvalue,
  scalarTypeInfo,
  selectLibraryFunctionOverload,
  setLocal,
  sourceU128Result,
  tryInlineStructMethod,
  usualConversion,
};

registerFunctionLoweringServices(FUNCTION_LOWERING_SERVICES);
