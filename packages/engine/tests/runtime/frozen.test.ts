import { expect, test } from "bun:test";
import { identityToBytes } from "@qinit/core";
import { QubicSimulator, parseFrozenIdentities } from "../../src";

// two real entries of core's frozen_addresses.h, in the header's own crlf layout
const FROZEN_HEADER = [
    "#pragma once",
    "#define FREEZE_FROM_TICK 86000000",
    "static const unsigned char gFrozenIdentities[][60 + 1] =",
    "{",
    '"IYGWQVSXGMSMAHXRZRKMNGNGHJFBICKEAKBJLRMZDBNVZMVQCSTCDWICOWKL",',
    '"AADANXUMGMTZLAKEMHXYIGSLEXABMTJUGMEUTCOEVECUSPWBMHPWEHFGUUJI",',
    "};",
].join("\r\n");
const ARBITRATOR = "AFZPUAIYVPNUYGJRQVLUKOPPVLHAZQTGLYAAUUNBXFTVTAMSBKQBLEIEPCVJ";

test("the simulator answers isFrozenIdentity from core's frozen list", () => {
    const frozen = parseFrozenIdentities(FROZEN_HEADER);
    expect(frozen.size).toBe(2);
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true, frozenIdentities: frozen });
    expect(sim.host.isFrozenIdentity(identityToBytes("IYGWQVSXGMSMAHXRZRKMNGNGHJFBICKEAKBJLRMZDBNVZMVQCSTCDWICOWKL"))).toBe(1);
    expect(sim.host.isFrozenIdentity(identityToBytes("AADANXUMGMTZLAKEMHXYIGSLEXABMTJUGMEUTCOEVECUSPWBMHPWEHFGUUJI"))).toBe(1);
    expect(sim.host.isFrozenIdentity(identityToBytes(ARBITRATOR))).toBe(0);
    expect(new QubicSimulator({ mempool: false, fees: "off", liteTicking: true }).host.isFrozenIdentity(identityToBytes(ARBITRATOR))).toBe(0);
});
