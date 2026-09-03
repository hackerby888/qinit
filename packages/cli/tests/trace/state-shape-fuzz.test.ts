// Two hundred state layouts nobody wrote by hand: structs three deep, arrays of arrays, every scalar
// width, containers behind struct fields. Each is laid out by the real compiler and filled with random
// bytes, and then the two decoders must draw the same rows, name every row and block exactly once, and
// the diff walker must place every row inside a field it knows.
import { expect, test } from "bun:test";
import { extractIdl } from "@qinit/build";
import { AbiTypeKind, type AbiType } from "@qinit/proto/contract-idl";
import { hex, stateSource } from "../format/diff-window";
import { stateDiffLines } from "../../src/trace/state-diff";
import { flatLine, stateFieldsOf } from "../../src/trace/state-format";
import { decodeValueBlocks, readState } from "../../src/trace/state-read";

const SEEDS = 200;
const SCALARS = ["uint8", "uint16", "uint32", "uint64", "sint8", "sint16", "sint32", "sint64", "id", "bit"];

// mulberry32: small, seedable, and the same sequence on every run.
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A member's C++ type and, relative to the member, the paths of the rows and container blocks the
// readers must name for it. A value that holds no container is one row, however deep its struct goes;
// a struct that holds one is opened up, field by field; nothing below a container is named at all.
type Shape = { type: string; rows: string[]; containers: string[] };

class Generator {
    readonly declarations: string[] = [];
    private structs = 0;

    constructor(private readonly next: () => number) {}

    pick<T>(items: readonly T[]): T {
        return items[Math.floor(this.next() * items.length)];
    }

    member(depth: number): Shape {
        const roll = this.next();
        if (roll < 0.4 || depth >= 3) {
            return this.scalar();
        }
        return roll < 0.65 ? this.struct(depth) : this.container(depth);
    }

    scalar(): Shape {
        return { type: this.pick(SCALARS), rows: [""], containers: [] };
    }

    struct(depth: number): Shape {
        const name = `S${this.structs++}`;
        const fields = Array.from({ length: 1 + Math.floor(this.next() * 4) }, (_, index) => ({ name: `f${index}`, shape: this.member(depth + 1) }));

        this.declarations.push(`struct ${name} { ${fields.map((field) => `${field.shape.type} ${field.name};`).join(" ")} };`);

        if (!fields.some((field) => field.shape.containers.length)) {
            return { type: name, rows: [""], containers: [] };
        }
        return {
            type: name,
            rows: fields.flatMap((field) => field.shape.rows.map((row) => `.${field.name}${row}`)),
            containers: fields.flatMap((field) => field.shape.containers.map((container) => `.${field.name}${container}`)),
        };
    }

    // A plain struct for an element or a value: no container inside, so a block stays one block.
    plain(depth: number): string {
        const shape = this.next() < 0.5 || depth >= 3 ? this.scalar() : this.struct(9);
        return shape.type;
    }

    container(depth: number): Shape {
        const count = this.pick([1, 2, 4]);
        const capacity = this.pick([4, 8]);
        const type = this.pick([
            () => `Array<${this.plain(depth)}, ${count}>`,
            () => `Array<Array<${this.pick(SCALARS)}, ${count}>, 2>`,
            () => `BitArray<${this.pick([64, 128])}>`,
            () => `HashMap<uint64, ${this.plain(depth)}, ${capacity}>`,
            () => `HashSet<uint64, ${capacity}>`,
            () => `Collection<${this.plain(depth)}, ${capacity}>`,
            () => `LinkedList<${this.plain(depth)}, ${capacity}>`,
        ])();

        return { type, rows: [], containers: [""] };
    }
}

// Random bytes wherever they are always a valid image; a keyed or linked container stays empty.
function fillImage(bytes: Uint8Array, type: AbiType, at: number, next: () => number) {
    switch (type.kind) {
        case AbiTypeKind.SCALAR:
            for (let index = 0; index < type.size; index++) {
                bytes[at + index] = Math.floor(next() * 256);
            }
            return;
        case AbiTypeKind.STRUCT:
            for (const field of type.fields) {
                fillImage(bytes, field.type, at + field.offset, next);
            }
            return;
        case AbiTypeKind.ARRAY:
            for (let index = 0; index < type.count; index++) {
                fillImage(bytes, type.element, at + index * (type.size / type.count), next);
            }
            return;
        case AbiTypeKind.BIT_ARRAY:
            for (let index = 0; index < type.size; index++) {
                bytes[at + index] = Math.floor(next() * 256);
            }
            return;
        default:
            return;
    }
}

const rows = (state: {
    fields: { name: string; value: string }[];
    containers: { name: string; occupiedSlots: number; totalEntries: number; lines: { label: string; text: string }[] }[];
}) => [
    ...state.fields.map((field) => `${field.name} = ${field.value}`),
    ...state.containers.flatMap((container) => [
        `${container.name} · ${container.occupiedSlots} · ${container.totalEntries}`,
        ...container.lines.map((line) => `${line.label} ${line.text}`),
    ]),
];

test(`${SEEDS} generated layouts decode the same on every surface and diff inside known fields`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
        const next = random(seed);
        const generator = new Generator(next);
        const members = Array.from({ length: 2 + Math.floor(next() * 5) }, (_, index) => ({ name: `m${index}`, shape: generator.member(0) }));
        const source = stateSource(members.map((member) => `${member.shape.type} ${member.name};`).join(" "), generator.declarations.join("\n  "));
        const idl = extractIdl(source, "Fuzz", { slot: 7 });
        const bytes = new Uint8Array(idl.state!.size);
        fillImage(bytes, idl.state!, 0, next);

        const blocks = await decodeValueBlocks(bytes, idl.state!);
        const rpc = { stateRead: async (_slot: number, off: number, len: number) => ({ hex: hex(bytes.subarray(off, off + len)) }) };
        const state = await readState(rpc, 7, source, "Fuzz", undefined, undefined, { loadAllContainers: true });

        expect(state.complete, `seed ${seed}\n${source}`).toBe(true);
        expect(rows(blocks), `seed ${seed}\n${source}`).toEqual(rows(state));
        expect(
            blocks.fields.map((field) => field.name),
            `seed ${seed}\n${source}`,
        ).toEqual(members.flatMap((member) => member.shape.rows.map((row) => member.name + row)));
        expect(
            blocks.containers.map((container) => container.name),
            `seed ${seed}\n${source}`,
        ).toEqual(members.flatMap((member) => member.shape.containers.map((container) => member.name + container)));

        const fields = stateFieldsOf(idl);
        const diff = await stateDiffLines(fields, [{ off: 0, before: hex(new Uint8Array(bytes.length)), after: hex(bytes) }]);
        const names = new Set(members.map((member) => member.name));
        // Slack after the last field is the one place a window may reach that no field names: the row
        // it earns there is deliberate, since a region past the state is how a stale IDL shows itself.
        const last = fields[fields.length - 1];
        const slackAt = last.off + last.size;

        for (const line of diff) {
            const slack = line.label.match(/^@(\d+)$/);
            expect(slack ? Number(slack[1]) >= slackAt : names.has(line.label.replace(/[[.+].*$/, "")), `seed ${seed}: ${flatLine(line)}\n${source}`).toBe(
                true,
            );
            expect(line.label, `seed ${seed}\n${source}`).not.toMatch(/\+\d+$/);
        }
        expect(diff.length > 0 || bytes.every((byte) => byte === 0), `seed ${seed}\n${source}`).toBe(true);
    }
}, 120_000);
