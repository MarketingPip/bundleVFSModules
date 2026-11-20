/*!
 * crypto/subtle-pkcs8 — Node 26 WebCrypto PKCS8 export normalization (L7).
 *
 * Host Node v24.22.1's subtle.exportKey('pkcs8', key) for an EC private
 * key preserves the key's stored encoding: a key imported from a minimal
 * PKCS8 (no public point in the inner SEC1) exports 67 bytes. Node
 * 26.13.1 always includes the public point (138 bytes) — probe-verified
 * natively on both runtimes, no shim involved. The KeyObject export path
 * preserves the minimal encoding on BOTH runtimes (67), so this is
 * specific to the WebCrypto export — the fix cannot live in the key
 * itself (re-encoding the key would break KeyObject.from(...).export
 * ('pkcs8'), which the same test asserts equals the 67-byte original).
 *
 * Fix: after the native export resolves, if the key is an EC private
 * CryptoKey and the inner SEC1 lacks the [1] public key, splice it in
 * (derived via createPublicKey → raw-public) and re-encode the DER
 * lengths. Any parse failure, non-EC key, already-present [1], or
 * derivation failure returns the native result unchanged — a successful
 * export is never turned into a throw, and native rejections pass
 * through untouched. Pure DER + promises; no Node imports — the native
 * key functions arrive as the `deriveRawPublic` callback.
 */

// DER length helpers -------------------------------------------------------
function readLen(buf, off) {
  if (off >= buf.length) return null;
  const b0 = buf[off];
  if (b0 < 0x80) return { length: b0, headerLen: 1 };
  const n = b0 & 0x7f;
  if (n === 0 || n > 2 || off + 1 + n > buf.length) return null;
  let length = 0;
  for (let i = 0; i < n; i++) length = (length << 8) | buf[off + 1 + i];
  return { length, headerLen: 1 + n };
}

function encodeLen(n) {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, (n >> 8) & 0xff, n & 0xff];
}

// TLV at buf[off] with the given tag, or null. `offset` is the tag
// position, so buf.subarray(t.offset, t.end) is the byte-exact TLV.
function readTlv(buf, off, tag) {
  if (off >= buf.length || buf[off] !== tag) return null;
  const l = readLen(buf, off + 1);
  if (!l) return null;
  const start = off + 1 + l.headerLen;
  if (start + l.length > buf.length) return null;
  return {
    offset: off,
    start,
    length: l.length,
    end: start + l.length,
    totalLen: 1 + l.headerLen + l.length,
  };
}

const EC_PUBLIC_KEY_OID = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];

export function isEcPrivateCryptoKey(key) {
  return (
    key?.type === "private" &&
    (key?.algorithm?.name === "ECDSA" || key?.algorithm?.name === "ECDH")
  );
}

/**
 * Build a `deriveRawPublic` callback from the native crypto module:
 * KeyObject.from(cryptoKey) → createPublicKey → uncompressed point
 * (0x04 || X || Y). Returns null on any failure, so the caller keeps
 * the native export result.
 */
export function makeDeriveRawPublic(native) {
  return function deriveRawPublic(cryptoKey) {
    try {
      const ko = native.KeyObject.from(cryptoKey);
      const pub = native.createPublicKey(ko);
      const raw = pub.export({ format: "raw-public" });
      if (!(raw instanceof Uint8Array) || raw.length < 2 || raw[0] !== 0x04) {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  };
}

/**
 * Parse an EC private PKCS8 whose inner SEC1 lacks the [1] public key.
 * Returns the TLV pieces needed to rebuild it, or null when no splice
 * applies (not EC, already has [1], unparseable, unexpected element).
 */
function parseSpliceablePkcs8(pkcs8) {
  const outer = readTlv(pkcs8, 0, 0x30);
  if (!outer || outer.end !== pkcs8.length) return null;
  const version = readTlv(pkcs8, outer.start, 0x02);
  if (!version || version.length !== 1 || pkcs8[version.start] !== 0) {
    return null;
  }
  const algId = readTlv(pkcs8, version.end, 0x30);
  if (!algId) return null;
  const oid = pkcs8.subarray(algId.start, algId.start + EC_PUBLIC_KEY_OID.length);
  if (
    oid.length !== EC_PUBLIC_KEY_OID.length ||
    !EC_PUBLIC_KEY_OID.every((b, i) => oid[i] === b)
  ) {
    return null; // Not an EC key.
  }
  const privOct = readTlv(pkcs8, algId.end, 0x04);
  if (!privOct || privOct.end !== outer.end) return null;
  const inner = pkcs8.subarray(privOct.start, privOct.end);
  const seq = readTlv(inner, 0, 0x30);
  if (!seq || seq.end !== inner.length) return null;
  const innerVer = readTlv(inner, seq.start, 0x02);
  if (!innerVer || innerVer.length !== 1 || inner[innerVer.start] !== 1) {
    return null;
  }
  // Walk the remaining inner elements: 04 (private octet), a0 ([0]
  // params, optional), a1 ([1] public key, optional).
  let octet = null;
  let params = null;
  let off = innerVer.end;
  while (off < seq.end) {
    const t = readTlv(inner, off, inner[off]);
    if (!t) return null;
    if (t.offset !== off) return null;
    if (inner[off] === 0x04 && !octet) octet = t;
    else if (inner[off] === 0xa0 && !params) params = t;
    else if (inner[off] === 0xa1) return null; // Already has the public key.
    else return null; // Unexpected element.
    off = t.end;
  }
  if (!octet || off !== seq.end) return null;
  return { bytes: pkcs8, inner, version, algId, innerVer, octet, params };
}

/**
 * Normalize a subtle.exportKey('pkcs8', key) promise to Node 26's form:
 * EC private keys always carry the public point in the inner SEC1.
 * Non-EC keys pass the native promise through untouched; any failure
 * keeps the native result.
 */
export function normalizeSubtlePkcs8Export(nativePromise, cryptoKey, deriveRawPublic) {
  if (!isEcPrivateCryptoKey(cryptoKey)) return nativePromise;
  return nativePromise.then((ab) => {
    try {
      const parsed = parseSpliceablePkcs8(new Uint8Array(ab));
      if (!parsed) return ab;
      const pub = deriveRawPublic(cryptoKey);
      if (!pub) return ab;
      const { bytes, inner, version, algId, innerVer, octet, params } = parsed;
      // [1] EXPLICIT BIT STRING: a1 { 03 { 00 <uncompressed point> } }.
      const bitString = [0x03, ...encodeLen(1 + pub.length), 0x00, ...pub];
      const a1 = [0xa1, ...encodeLen(bitString.length), ...bitString];
      const slice = (buf, t) => buf.subarray(t.offset, t.end);
      const newInnerContent = [
        ...slice(inner, innerVer),
        ...slice(inner, octet),
        ...(params ? [...slice(inner, params)] : []),
        ...a1,
      ];
      const newInner = [0x30, ...encodeLen(newInnerContent.length), ...newInnerContent];
      const newPrivOct = [0x04, ...encodeLen(newInner.length), ...newInner];
      const newOuterContent = [
        ...slice(bytes, version),
        ...slice(bytes, algId),
        ...newPrivOct,
      ];
      return new Uint8Array([
        0x30,
        ...encodeLen(newOuterContent.length),
        ...newOuterContent,
      ]).buffer;
    } catch {
      return ab;
    }
  });
}
