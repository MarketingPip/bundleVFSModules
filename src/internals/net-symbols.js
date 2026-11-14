// Shared symbols for the net shim.
//
// Lives here (not in src/net.js) so the parity adapter
// parity/internal-net-adapter.mjs can import the symbol without loading
// the whole net shim — the src/internals/http-symbols.js precedent
// (kOutHeaders): the test reads the symbol from Node's `internal/net`,
// and the adapter re-exports real Node's module with this symbol, so the
// symbol the shim marks results with and the symbol the test reads are
// the same object.
export const normalizedArgsSymbol = Symbol("normalizedArgs");
