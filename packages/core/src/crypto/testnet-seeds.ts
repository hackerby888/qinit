// The seeds a Qubic testnet node prefunds at genesis: its broadcast computors. A dev node that funds the
// same eight lets one saved seed sign on either runtime, so the default signer is drawn from here first.
export const TESTNET_FUNDED_SEEDS: readonly string[] = [
    "eraaastggldisjhoojaekgyimrsddjxbvgaawswfvnvaygqmusnkevv",
    "sgwnpzidgxbclnisgehigeculaejjxedzdkjyyfrzgzvuojrhdzywfh",
    "xeejtwxqrrlvacapbujaleejhbrsnnpvviknskemmgdihggpssjjkrg",
    "hwrmwgyjvytgemdqcewrufgumgukfsvgudaqnujykjnindlaxkjzrke",
    "pvdlzxjxnzbrlutlcvjfnmcmwmyyjzifczztqycnultdaekezffkpdz",
    "apmtsmsnrawvzwdympngnxfivnktidmfdhtltprsepmryihmeqteokh",
    "knxhupfxcfyvkrrdawbkotquiqrgzlijmltmxmpddtprtkmvmmvrxoc",
    "dislmzydvccdsghqdfploggiheykqntsevpublwwglnqfeyapqymhtj",
];

/** The seed every runtime funds, used when neither the user nor the node names one. */
export const DEFAULT_FUNDED_SEED = TESTNET_FUNDED_SEEDS[0];
