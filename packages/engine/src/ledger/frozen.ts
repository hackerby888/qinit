import { identityToBytes } from "@qinit/core";
import { toHex } from "../support/k12";

// the quoted identities of core's frozen_addresses.h, keyed the way the spectrum ledger keys ids
export function parseFrozenIdentities(frozenAddressesHeader: string): Set<string> {
    const frozen = new Set<string>();
    for (const [, identity] of frozenAddressesHeader.matchAll(/"([A-Z]{60})"/g)) {
        frozen.add(toHex(identityToBytes(identity)));
    }
    return frozen;
}
