/*!
 * crypto/sec1 — Node 26 SEC1 export normalization (L7).
 *
 * Host Node v24.22.1's SEC1 export of an EC private key is usage-history
 * dependent: a key imported from a PKCS8 whose inner SEC1 carries the
 * EC parameters exports 121 bytes (with the [0] parameters) when fresh,
 * but after the key has been used for several concurrent sign/verify
 * operations the same export drops the parameters (109 bytes) — proven
 * by test-crypto-key-reuse-concurrent run 1, iteration 5, main thread,
 * on plain host Node (no shim involved). Node 26.13.1 is stable: the
 * export always matches a fresh import of the same key (121 for the
 * PEM-derived key, 51 for the minimal-SEC1 key whose source carries no
 * parameters — so this is NOT "always insert parameters").
 *
 * Fix: patch the native export method once (a per-instance wrapper cannot
 * work — the test structuredClones the key every iteration, and clones
 * drop own properties). For sec1+der exports of EC private keys, the
 * canonical result is what a fresh import of the key's own PKCS8 export
 * produces; the PKCS8 export itself is stable (the test asserts it at
 * :111 before the SEC1 assertion, and it passes on the host). Any failure
 * in the round-trip (non-extractable key, passphrase-protected export,
 * non-EC key) falls back to the native result — a successful export is
 * never turned into a throw.
 *
 * Where the method lives: on host v24.22.1 `KeyObject.prototype` does
 * NOT carry `export` — the chain is instance → PrivateKeyObject
 * .prototype (owns `export`) → AsymmetricKeyObject.prototype →
 * KeyObject.prototype, and PrivateKeyObject is not exported from
 * 'crypto'. The patch reaches it via a throwaway generated P-256 key
 * (discarded); the prototype object is shared by every private key
 * (generated, imported, cloned, transferred), so one patch covers the
 * test's fresh clones. If the throwaway generation fails, the patch
 * bails out and exports stay native.
 *
 * Native bridge only: called from ../crypto.js when `native` exists.
 * No-op in the browser fallback (there is no native KeyObject there).
 */

let patched = false;

export function patchSec1Export(native) {
  if (patched) return;
  let privateProto;
  try {
    const { privateKey } = native.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    privateProto = Object.getPrototypeOf(privateKey);
  } catch {
    return;
  }
  if (!privateProto || typeof privateProto.export !== "function") return;
  if (typeof native.createPrivateKey !== "function") return;
  const origExport = privateProto.export;
  const wrappedExport = function (options) {
    const result = origExport.call(this, options);
    try {
      if (!options || options.type !== "sec1" || options.format !== "der") {
        return result;
      }
      if (!(result instanceof Uint8Array)) return result;
      if (this.asymmetricKeyType !== "ec") return result;
      const pkcs8 = origExport.call(this, { type: "pkcs8", format: "der" });
      const fresh = native.createPrivateKey({
        key: pkcs8,
        format: "der",
        type: "pkcs8",
      });
      const canonical = origExport.call(fresh, {
        type: "sec1",
        format: "der",
      });
      if (canonical instanceof Uint8Array) return canonical;
    } catch {
      // Fall through: keep the native result.
    }
    return result;
  };
  privateProto.export = wrappedExport;
  patched = true;
}
