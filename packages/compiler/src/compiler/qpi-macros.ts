import { Preprocessor, type MacroDef } from "../preprocess";
import { IMPL_BOUNDARY } from "../qpi-snapshot-format";

const cache = new Map<
  string,
  {
    preprocessedSource: string;
    macros: Map<string, MacroDef>;
  }
>();

export function getQpiPrelude(headers: string): {
  preprocessedSource: string;
  macros: Map<string, MacroDef>;
} {
  const [mainHeaders] = headers.split(IMPL_BOUNDARY);
  const cached = cache.get(mainHeaders);
  if (cached) {
    return cached;
  }

  const preprocessor = new Preprocessor();
  const preprocessedSource = preprocessor.preprocess({
    source: "",
    qpiHeader: mainHeaders,
    contractName: "__lib__",
    contractIndex: 0,
  });
  const prelude = {
    preprocessedSource,
    macros: preprocessor.getDefines(),
  };
  cache.set(mainHeaders, prelude);
  return prelude;
}

export function getQpiMacros(headers: string): Map<string, MacroDef> {
  return getQpiPrelude(headers).macros;
}
