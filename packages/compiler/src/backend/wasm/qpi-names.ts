// The two QPI names the backend recognises by spelling rather than by type.

// Inside a proxy class, `pv` and `qpi` are aliases the caller already supplied, so they take no local slot.
export function isProxyAliasLocal(name: string): boolean {
    return name === "pv" || name === "qpi";
}

// A contract entry takes the QPI context as its first parameter, named `qpi` by convention.
export function isQpiContextParam(parameter: { name: string } | undefined): boolean {
    return parameter?.name === "qpi";
}
