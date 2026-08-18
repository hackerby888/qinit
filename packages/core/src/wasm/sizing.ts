// Memory sizes both compiler backends and the engine have to agree on. Everything that lays out a
// contract's linear memory reads them from here, so a change lands in one place instead of five.
//
// The C++ side cannot import this file: `module_storage.h` declares the same layout as a static array
// and carries its own `WASM_ARENA_SIZE` default. That agreement is asserted by a test rather than
// enforced by the type system — see `packages/core/tests/wasm/sizing.test.ts`.

/** Entry input buffer, at `io_base()`. */
export const INPUT_BUFFER_BYTES = 64 * 1024;

/** Entry output buffer, immediately after the input buffer. */
export const OUTPUT_BUFFER_BYTES = 64 * 1024;

/** Scratch for an entry's locals, immediately after the output buffer. */
export const LOCALS_BUFFER_BYTES = 32 * 1024;

/** The three fixed buffers that sit ahead of the scratch arena inside `io_size()`. */
export const IO_BUFFER_BYTES = INPUT_BUFFER_BYTES + OUTPUT_BUFFER_BYTES + LOCALS_BUFFER_BYTES;

/** Scratch arena a contract gets when the build does not ask for a different size. */
export const DEFAULT_ARENA_BYTES = 1024 * 1024 * 1024;

/** Arena for gtest builds, where several modules are packed into one address space. */
export const DEFAULT_GTEST_ARENA_BYTES = 16 * 1024 * 1024;

/** Write-journal budget for undo entries. Capacity is also clamped to the blocks a state actually has. */
export const DEFAULT_JOURNAL_CAP_BYTES = 64 * 1024 * 1024;

/**
 * Memory reserved for the write journal, past the arena rather than inside it: the contract keeps its
 * whole arena and a host that knows nothing about the journal still sees the region it expects from
 * `io_size()`. Sized to hold the default budget with its probe table, page-aligned, and left untouched
 * when a contract needs less — the pages only commit as blocks are recorded.
 */
export const JOURNAL_REGION_BYTES = 72 * 1024 * 1024;
