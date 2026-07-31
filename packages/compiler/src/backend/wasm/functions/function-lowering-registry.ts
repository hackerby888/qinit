import type { FunctionLoweringServices } from "./function-lowering-contract";

let registeredServices: FunctionLoweringServices | undefined;

export function registerFunctionLoweringServices(
  services: FunctionLoweringServices,
): void {
  registeredServices = services;
}

export function getFunctionLoweringServices(): FunctionLoweringServices {
  if (!registeredServices) {
    throw new Error("function lowering services are not registered");
  }

  return registeredServices;
}
