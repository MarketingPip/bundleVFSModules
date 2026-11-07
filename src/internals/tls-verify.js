// src/internals/tls-verify.js — minimal X.509 DER parsing + name-based
// chain trust for the virtual TLS handshake (https client verification).
//
// Internal helper, not part of the node:tls export surface (which is
// pinned exact by tests/export_surface_tls.test.js): the DER parser and
// verifyPeerCertificate live here so src/tls.js keeps its exact export
// list. Imported by src/http.js only.
//
// The virtual transport performs no TLS handshake, so there is no
// signature to verify against. What the peer-certificate checks need is
// the certificate's *content* (subject/issuer names, SANs) and a trust
// rule the tests can observe: the leaf's issuer must match the subject
// of a CA the client supplied (or the leaf itself, for a self-signed
// cert presented as its own CA). parseCertificate extracts the content;
// verifyPeerCertificate applies the rule (Node
// lib/internal/tls/wrap.js onConnectSecure: ssl.verifyError() first,
// then checkServerIdentity).
//
// ponytail: ceiling — name matching is not cryptographic verification.
// A signature check needs a real TLS stack (L12's raw transport does
// not add one either); until then this is the documented emulation,
// and it only ever runs against certificates the local server presented.

// ---------------------------------------------------------------------------
// Minimal X.509 DER parsing + name-based chain trust
// ---------------------------------------------------------------------------
//
// The virtual transport performs no TLS handshake, so there is no
// signature to verify against. What the peer-certificate checks need is
// the certificate's *content* (subject/issuer names, SANs) and a trust
// rule the tests can observe: the leaf's issuer must match the subject
// of a CA the client supplied (or the leaf itself, for a self-signed
// cert presented as its own CA). parseCertificate extracts the content;
// verifyPeerCertificate applies the rule (Node
// lib/internal/tls/wrap.js onConnectSecure: ssl.verifyError() first,
// then checkServerIdentity).
//
// ponytail: ceiling — name matching is not cryptographic verification.
// A signature check needs a real TLS stack (L12's raw transport does
// not add one either); until then this is the documented emulation,
// and it only ever runs against certificates the local server presented.

function _derRead(buf, offset) {
  const tag = buf[offset];
  let length = buf[offset + 1];
  let headerLen = 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++) length = (length << 8) | buf[offset + 2 + i];
    headerLen = 2 + n;
  }
  const valueStart = offset + headerLen;
  return { tag, length, valueStart, end: valueStart + length };
}

function _derChildren(buf, offset, end) {
  const out = [];
  let pos = offset;
  while (pos < end) {
    const tlv = _derRead(buf, pos);
    out.push(tlv);
    pos = tlv.end;
  }
  return out;
}

function _derOID(buf, start, end) {
  const bytes = buf.subarray(start, end);
  if (bytes.length === 0) return "";
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = (value << 7) | (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function _derString(buf, tlv) {
  const bytes = buf.subarray(tlv.valueStart, tlv.end);
  if (tlv.tag === 0x0c) {
    // UTF8String
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (tlv.tag === 0x1e) {
    // BMPString (UTF-16BE)
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return s;
  }
  // PrintableString / IA5String / TeletexString / VisibleString: latin1.
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

// Short names Node's getPeerCertificate() uses for RDN attributes.
const _NAME_OIDS = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "1.2.840.113549.1.9.1": "emailAddress",
};

// Parses an X.509 Name (RDNSequence) TLV. Returns { fields, key }: fields
// maps short names to values (arrays when an attribute repeats, as in
// Node's getPeerCertificate), key is a canonical JSON of every [oid,
// value] pair — the chain-matching identity, robust to attribute order.
function _derName(buf, tlv) {
  const fields = {};
  const pairs = [];
  for (const rdn of _derChildren(buf, tlv.valueStart, tlv.end)) {
    for (const atv of _derChildren(buf, rdn.valueStart, rdn.end)) {
      // AttributeTypeAndValue is a SEQUENCE { OID, value }.
      const atvParts = _derChildren(buf, atv.valueStart, atv.end);
      const oidTlv = atvParts[0];
      const valueTlv = atvParts[1];
      if (oidTlv === undefined || valueTlv === undefined) continue;
      const oid = _derOID(buf, oidTlv.valueStart, oidTlv.end);
      const value = _derString(buf, valueTlv);
      pairs.push([oid, value]);
      const short = _NAME_OIDS[oid];
      if (short === undefined) continue;
      if (fields[short] === undefined) fields[short] = value;
      else if (Array.isArray(fields[short])) fields[short].push(value);
      else fields[short] = [fields[short], value];
    }
  }
  pairs.sort();
  return { fields, key: JSON.stringify(pairs) };
}

function _formatIPBytes(bytes) {
  if (bytes.length === 4) return [...bytes].join(".");
  if (bytes.length === 16) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    }
    return groups.join(":");
  }
  return "";
}

// Parses the subjectAltName extension (OID 2.5.5.17) out of a certificate's
// [3] extensions wrapper. Returns ["DNS:...", "IP Address:..."] entries in
// Node's getPeerCertificate() subjectaltname string format.
function _derSubjectAltNames(buf, tlv) {
  const names = [];
  const wrapper = _derChildren(buf, tlv.valueStart, tlv.end);
  if (wrapper.length === 0) return names;
  for (const ext of _derChildren(buf, wrapper[0].valueStart, wrapper[0].end)) {
    const parts = _derChildren(buf, ext.valueStart, ext.end);
    if (parts.length === 0) continue;
    if (_derOID(buf, parts[0].valueStart, parts[0].end) !== "2.5.5.17")
      continue;
    const valueTlv = parts[parts.length - 1]; // OCTET STRING
    const inner = _derRead(buf, valueTlv.valueStart);
    for (const gn of _derChildren(buf, inner.valueStart, inner.end)) {
      const bytes = buf.subarray(gn.valueStart, gn.end);
      if (gn.tag === 0x82) {
        // dNSName (IA5String)
        let s = "";
        for (const b of bytes) s += String.fromCharCode(b);
        names.push(`DNS:${s}`);
      } else if (gn.tag === 0x87) {
        // iPAddress (OCTET STRING)
        names.push(`IP Address:${_formatIPBytes(bytes)}`);
      }
    }
  }
  return names;
}

function _pemToDer(input) {
  if (typeof input === "string") {
    return _pemTextToDer(input);
  }
  if (input instanceof Uint8Array) {
    // A Buffer may hold PEM text (fixtures.readKey returns a Buffer of
    // the PEM file) or raw DER — sniff the header, don't assume.
    let text = "";
    const head = input.subarray(0, 27);
    for (const b of head) text += String.fromCharCode(b);
    if (text.startsWith("-----BEGIN")) {
      let full = "";
      for (const b of input) full += String.fromCharCode(b);
      return _pemTextToDer(full);
    }
    return input;
  }
  return null;
}

function _pemTextToDer(text) {
  const b64 = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
    return der;
  } catch {
    return null;
  }
}

// Parses a PEM (string) or DER (Buffer/Uint8Array) X.509 certificate into
// Node's getPeerCertificate() shape for the fields the TLS checks use:
// { subject, issuer, subjectaltname }. _subjectKey/_issuerKey are the
// canonical name identities used by verifyPeerCertificate (internal).
// Returns null when the input is missing or unparsable.
export function parseCertificate(input) {
  const der = _pemToDer(input);
  if (der === null || der.length < 2) return null;
  try {
    const root = _derRead(der, 0);
    if (root.tag !== 0x30) return null;
    const certChildren = _derChildren(der, root.valueStart, root.end);
    const tbs = certChildren[0];
    if (tbs === undefined || tbs.tag !== 0x30) return null;
    const tbsChildren = _derChildren(der, tbs.valueStart, tbs.end);
    // TBSCertificate: [version [0]] serial signature issuer validity
    // subject spki [issuerUID [1]] [subjectUID [2]] [extensions [3]].
    let i = 0;
    if (tbsChildren[0] !== undefined && tbsChildren[0].tag === 0xa0) i = 1;
    const issuerTlv = tbsChildren[i + 2];
    const subjectTlv = tbsChildren[i + 4];
    if (
      issuerTlv === undefined ||
      subjectTlv === undefined ||
      issuerTlv.tag !== 0x30 ||
      subjectTlv.tag !== 0x30
    )
      return null;
    const issuer = _derName(der, issuerTlv);
    const subject = _derName(der, subjectTlv);
    let subjectaltname = "";
    for (let j = i + 5; j < tbsChildren.length; j++) {
      if (tbsChildren[j].tag === 0xa3) {
        const sans = _derSubjectAltNames(der, tbsChildren[j]);
        if (sans.length > 0) subjectaltname = sans.join(", ");
      }
    }
    return {
      subject: subject.fields,
      issuer: issuer.fields,
      subjectaltname,
      _subjectKey: subject.key,
      _issuerKey: issuer.key,
    };
  } catch {
    return null;
  }
}

// Chain trust for the virtual transport: the leaf's issuer must match the
// subject of a CA the client supplied (ca may be a PEM string/Buffer or
// an array of them, as in Node). With no CA supplied nothing is trusted
// — the shim ships no Mozilla root store (see rootCertificates), so the
// default is distrust, exactly as the simple/client-reject tests show.
// Returns null when trusted, an Error otherwise. OpenSSL distinguishes
// a self-signed leaf (error 18, DEPTH_ZERO_SELF_SIGNED_CERT) from an
// untrusted CA-signed leaf (error 21, UNABLE_TO_VERIFY_LEAF_SIGNATURE)
// — test-https-strict asserts both codes via authorizationError.
export function verifyPeerCertificate(peerCert, ca) {
  const cas =
    ca === undefined || ca === null ? [] : Array.isArray(ca) ? ca : [ca];
  for (const entry of cas) {
    const caCert = parseCertificate(entry);
    if (caCert !== null && caCert._subjectKey === peerCert._issuerKey)
      return null;
  }
  if (peerCert._subjectKey === peerCert._issuerKey) {
    const err = new Error("self-signed certificate");
    err.code = "DEPTH_ZERO_SELF_SIGNED_CERT";
    return err;
  }
  const err = new Error("unable to verify the first certificate");
  err.code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
  return err;
}
