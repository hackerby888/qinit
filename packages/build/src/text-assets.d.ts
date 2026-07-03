// `.h` harness headers are imported as text (`import X from "./assets/x.h" with { type: "text" }`) and
// embedded into the binary by `bun build --compile`. Declare the module shape so tsc resolves them.
declare module "*.h" {
  const content: string;
  export default content;
}
