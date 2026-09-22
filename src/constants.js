// src/constants.js — port of node:constants for the browser runtime.
//
// A static bag of numeric (and two string) constants: errno codes, signal
// numbers, fs open/mode/access flags, dlopen (RTLD_*) flags, process
// priorities (PRIORITY_*), libuv (UV_*) option flags, copyfile flags, and
// OpenSSL (SSL_OP_*/ENGINE_*/DH_*/RSA_*) constants.
//
// Values were captured verbatim from Node v24.20.0's node:constants on
// Linux x64; 234 numbers and the two default cipher-list strings.
//
// Platform caveats (mirrors constants-browserify's POSIX selection):
//   - errno and signal numbers follow POSIX; they match macOS, while a few
//     differ on Windows (Windows-only WSA errno codes are absent, as in
//     Node's own lib/constants.js which is POSIX-only).
//   - UV_*/RTLD_*/PRIORITY_* values are the Linux ones.
//   - defaultCoreCipherList / defaultCipherList come from the OpenSSL build
//     bundled with Node v24.20.0.
// The real module freezes its export object; we mirror that: the default
// export is Object.freeze()d, and ESM namespaces are immutable by
// construction, so named imports are frozen too.
//
// No runtime access, no globals, no dependencies — pure literals, so the
// browser-fallback lane is trivially satisfied.

// File access mode flags (F_OK, R_OK, W_OK, X_OK)
export const F_OK = 0;
export const R_OK = 4;
export const W_OK = 2;
export const X_OK = 1;

// File open flags (O_*)
export const O_APPEND = 1024;
export const O_CREAT = 64;
export const O_DIRECT = 16384;
export const O_DIRECTORY = 65536;
export const O_DSYNC = 4096;
export const O_EXCL = 128;
export const O_NOATIME = 262144;
export const O_NOCTTY = 256;
export const O_NOFOLLOW = 131072;
export const O_NONBLOCK = 2048;
export const O_RDONLY = 0;
export const O_RDWR = 2;
export const O_SYNC = 1052672;
export const O_TRUNC = 512;
export const O_WRONLY = 1;

// File type and permission bits (S_*)
export const S_IFBLK = 24576;
export const S_IFCHR = 8192;
export const S_IFDIR = 16384;
export const S_IFIFO = 4096;
export const S_IFLNK = 40960;
export const S_IFMT = 61440;
export const S_IFREG = 32768;
export const S_IFSOCK = 49152;
export const S_IRGRP = 32;
export const S_IROTH = 4;
export const S_IRUSR = 256;
export const S_IRWXG = 56;
export const S_IRWXO = 7;
export const S_IRWXU = 448;
export const S_IWGRP = 16;
export const S_IWOTH = 2;
export const S_IWUSR = 128;
export const S_IXGRP = 8;
export const S_IXOTH = 1;
export const S_IXUSR = 64;

// POSIX errno codes (E*)
export const E2BIG = 7;
export const EACCES = 13;
export const EADDRINUSE = 98;
export const EADDRNOTAVAIL = 99;
export const EAFNOSUPPORT = 97;
export const EAGAIN = 11;
export const EALREADY = 114;
export const EBADF = 9;
export const EBADMSG = 74;
export const EBUSY = 16;
export const ECANCELED = 125;
export const ECHILD = 10;
export const ECONNABORTED = 103;
export const ECONNREFUSED = 111;
export const ECONNRESET = 104;
export const EDEADLK = 35;
export const EDESTADDRREQ = 89;
export const EDOM = 33;
export const EDQUOT = 122;
export const EEXIST = 17;
export const EFAULT = 14;
export const EFBIG = 27;
export const EHOSTUNREACH = 113;
export const EIDRM = 43;
export const EILSEQ = 84;
export const EINPROGRESS = 115;
export const EINTR = 4;
export const EINVAL = 22;
export const EIO = 5;
export const EISCONN = 106;
export const EISDIR = 21;
export const ELOOP = 40;
export const EMFILE = 24;
export const EMLINK = 31;
export const EMSGSIZE = 90;
export const EMULTIHOP = 72;
export const ENAMETOOLONG = 36;
export const ENETDOWN = 100;
export const ENETRESET = 102;
export const ENETUNREACH = 101;
export const ENFILE = 23;
export const ENGINE_METHOD_ALL = 65535;
export const ENGINE_METHOD_CIPHERS = 64;
export const ENGINE_METHOD_DH = 4;
export const ENGINE_METHOD_DIGESTS = 128;
export const ENGINE_METHOD_DSA = 2;
export const ENGINE_METHOD_EC = 2048;
export const ENGINE_METHOD_NONE = 0;
export const ENGINE_METHOD_PKEY_ASN1_METHS = 1024;
export const ENGINE_METHOD_PKEY_METHS = 512;
export const ENGINE_METHOD_RAND = 8;
export const ENGINE_METHOD_RSA = 1;
export const ENOBUFS = 105;
export const ENODATA = 61;
export const ENODEV = 19;
export const ENOENT = 2;
export const ENOEXEC = 8;
export const ENOLCK = 37;
export const ENOLINK = 67;
export const ENOMEM = 12;
export const ENOMSG = 42;
export const ENOPROTOOPT = 92;
export const ENOSPC = 28;
export const ENOSR = 63;
export const ENOSTR = 60;
export const ENOSYS = 38;
export const ENOTCONN = 107;
export const ENOTDIR = 20;
export const ENOTEMPTY = 39;
export const ENOTSOCK = 88;
export const ENOTSUP = 95;
export const ENOTTY = 25;
export const ENXIO = 6;
export const EOPNOTSUPP = 95;
export const EOVERFLOW = 75;
export const EPERM = 1;
export const EPIPE = 32;
export const EPROTO = 71;
export const EPROTONOSUPPORT = 93;
export const EPROTOTYPE = 91;
export const ERANGE = 34;
export const EROFS = 30;
export const ESPIPE = 29;
export const ESRCH = 3;
export const ESTALE = 116;
export const ETIME = 62;
export const ETIMEDOUT = 110;
export const ETXTBSY = 26;
export const EWOULDBLOCK = 11;
export const EXDEV = 18;

// Signal numbers (SIG*)
export const SIGABRT = 6;
export const SIGALRM = 14;
export const SIGBUS = 7;
export const SIGCHLD = 17;
export const SIGCONT = 18;
export const SIGFPE = 8;
export const SIGHUP = 1;
export const SIGILL = 4;
export const SIGINT = 2;
export const SIGIO = 29;
export const SIGIOT = 6;
export const SIGKILL = 9;
export const SIGPIPE = 13;
export const SIGPOLL = 29;
export const SIGPROF = 27;
export const SIGPWR = 30;
export const SIGQUIT = 3;
export const SIGSEGV = 11;
export const SIGSTKFLT = 16;
export const SIGSTOP = 19;
export const SIGSYS = 31;
export const SIGTERM = 15;
export const SIGTRAP = 5;
export const SIGTSTP = 20;
export const SIGTTIN = 21;
export const SIGTTOU = 22;
export const SIGURG = 23;
export const SIGUSR1 = 10;
export const SIGUSR2 = 12;
export const SIGVTALRM = 26;
export const SIGWINCH = 28;
export const SIGXCPU = 24;
export const SIGXFSZ = 25;

// Dynamic linker flags (RTLD_*)
export const RTLD_DEEPBIND = 8;
export const RTLD_GLOBAL = 256;
export const RTLD_LAZY = 1;
export const RTLD_LOCAL = 0;
export const RTLD_NOW = 2;

// Process scheduling priorities (PRIORITY_*)
export const PRIORITY_ABOVE_NORMAL = -7;
export const PRIORITY_BELOW_NORMAL = 10;
export const PRIORITY_HIGH = -14;
export const PRIORITY_HIGHEST = -20;
export const PRIORITY_LOW = 19;
export const PRIORITY_NORMAL = 0;

// libuv option flags (UV_*)
export const UV_DIRENT_BLOCK = 7;
export const UV_DIRENT_CHAR = 6;
export const UV_DIRENT_DIR = 2;
export const UV_DIRENT_FIFO = 4;
export const UV_DIRENT_FILE = 1;
export const UV_DIRENT_LINK = 3;
export const UV_DIRENT_SOCKET = 5;
export const UV_DIRENT_UNKNOWN = 0;
export const UV_FS_COPYFILE_EXCL = 1;
export const UV_FS_COPYFILE_FICLONE = 2;
export const UV_FS_COPYFILE_FICLONE_FORCE = 4;
export const UV_FS_O_FILEMAP = 0;
export const UV_FS_SYMLINK_DIR = 1;
export const UV_FS_SYMLINK_JUNCTION = 2;

// Copyfile flags (COPYFILE_*)
export const COPYFILE_EXCL = 1;
export const COPYFILE_FICLONE = 2;
export const COPYFILE_FICLONE_FORCE = 4;

// OpenSSL version information
export const OPENSSL_VERSION_NUMBER = 810549360;

// SSL/TLS option flags (SSL_OP_*)
export const SSL_OP_ALL = 2147485776;
export const SSL_OP_ALLOW_NO_DHE_KEX = 1024;
export const SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION = 262144;
export const SSL_OP_CIPHER_SERVER_PREFERENCE = 4194304;
export const SSL_OP_CISCO_ANYCONNECT = 32768;
export const SSL_OP_COOKIE_EXCHANGE = 8192;
export const SSL_OP_CRYPTOPRO_TLSEXT_BUG = 2147483648;
export const SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS = 2048;
export const SSL_OP_LEGACY_SERVER_CONNECT = 4;
export const SSL_OP_NO_COMPRESSION = 131072;
export const SSL_OP_NO_ENCRYPT_THEN_MAC = 524288;
export const SSL_OP_NO_QUERY_MTU = 4096;
export const SSL_OP_NO_RENEGOTIATION = 1073741824;
export const SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION = 65536;
export const SSL_OP_NO_SSLv2 = 0;
export const SSL_OP_NO_SSLv3 = 33554432;
export const SSL_OP_NO_TICKET = 16384;
export const SSL_OP_NO_TLSv1 = 67108864;
export const SSL_OP_NO_TLSv1_1 = 268435456;
export const SSL_OP_NO_TLSv1_2 = 134217728;
export const SSL_OP_NO_TLSv1_3 = 536870912;
export const SSL_OP_PRIORITIZE_CHACHA = 2097152;
export const SSL_OP_TLS_ROLLBACK_BUG = 8388608;
export const TLS1_1_VERSION = 770;
export const TLS1_2_VERSION = 771;
export const TLS1_3_VERSION = 772;
export const TLS1_VERSION = 769;

// Diffie-Hellman constants (DH_*)
export const DH_CHECK_P_NOT_PRIME = 1;
export const DH_CHECK_P_NOT_SAFE_PRIME = 2;
export const DH_NOT_SUITABLE_GENERATOR = 8;
export const DH_UNABLE_TO_CHECK_GENERATOR = 4;

// RSA constants (RSA_*)
export const RSA_NO_PADDING = 3;
export const RSA_PKCS1_OAEP_PADDING = 4;
export const RSA_PKCS1_PADDING = 1;
export const RSA_PKCS1_PSS_PADDING = 6;
export const RSA_PSS_SALTLEN_AUTO = -2;
export const RSA_PSS_SALTLEN_DIGEST = -1;
export const RSA_PSS_SALTLEN_MAX_SIGN = -2;
export const RSA_SSLV23_PADDING = 2;
export const RSA_X931_PADDING = 5;

// Elliptic-curve point conversion forms (POINT_CONVERSION_*)
export const POINT_CONVERSION_COMPRESSED = 2;
export const POINT_CONVERSION_HYBRID = 6;
export const POINT_CONVERSION_UNCOMPRESSED = 4;

// Default cipher lists (strings, from the bundled OpenSSL build)
export const defaultCipherList = "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
export const defaultCoreCipherList = "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";

// Default namespace export (mirrors require('node:constants')) — frozen
// exactly like the real module's exports object.
const constants = {
  F_OK,
  R_OK,
  W_OK,
  X_OK,
  O_APPEND,
  O_CREAT,
  O_DIRECT,
  O_DIRECTORY,
  O_DSYNC,
  O_EXCL,
  O_NOATIME,
  O_NOCTTY,
  O_NOFOLLOW,
  O_NONBLOCK,
  O_RDONLY,
  O_RDWR,
  O_SYNC,
  O_TRUNC,
  O_WRONLY,
  S_IFBLK,
  S_IFCHR,
  S_IFDIR,
  S_IFIFO,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  S_IFSOCK,
  S_IRGRP,
  S_IROTH,
  S_IRUSR,
  S_IRWXG,
  S_IRWXO,
  S_IRWXU,
  S_IWGRP,
  S_IWOTH,
  S_IWUSR,
  S_IXGRP,
  S_IXOTH,
  S_IXUSR,
  E2BIG,
  EACCES,
  EADDRINUSE,
  EADDRNOTAVAIL,
  EAFNOSUPPORT,
  EAGAIN,
  EALREADY,
  EBADF,
  EBADMSG,
  EBUSY,
  ECANCELED,
  ECHILD,
  ECONNABORTED,
  ECONNREFUSED,
  ECONNRESET,
  EDEADLK,
  EDESTADDRREQ,
  EDOM,
  EDQUOT,
  EEXIST,
  EFAULT,
  EFBIG,
  EHOSTUNREACH,
  EIDRM,
  EILSEQ,
  EINPROGRESS,
  EINTR,
  EINVAL,
  EIO,
  EISCONN,
  EISDIR,
  ELOOP,
  EMFILE,
  EMLINK,
  EMSGSIZE,
  EMULTIHOP,
  ENAMETOOLONG,
  ENETDOWN,
  ENETRESET,
  ENETUNREACH,
  ENFILE,
  ENGINE_METHOD_ALL,
  ENGINE_METHOD_CIPHERS,
  ENGINE_METHOD_DH,
  ENGINE_METHOD_DIGESTS,
  ENGINE_METHOD_DSA,
  ENGINE_METHOD_EC,
  ENGINE_METHOD_NONE,
  ENGINE_METHOD_PKEY_ASN1_METHS,
  ENGINE_METHOD_PKEY_METHS,
  ENGINE_METHOD_RAND,
  ENGINE_METHOD_RSA,
  ENOBUFS,
  ENODATA,
  ENODEV,
  ENOENT,
  ENOEXEC,
  ENOLCK,
  ENOLINK,
  ENOMEM,
  ENOMSG,
  ENOPROTOOPT,
  ENOSPC,
  ENOSR,
  ENOSTR,
  ENOSYS,
  ENOTCONN,
  ENOTDIR,
  ENOTEMPTY,
  ENOTSOCK,
  ENOTSUP,
  ENOTTY,
  ENXIO,
  EOPNOTSUPP,
  EOVERFLOW,
  EPERM,
  EPIPE,
  EPROTO,
  EPROTONOSUPPORT,
  EPROTOTYPE,
  ERANGE,
  EROFS,
  ESPIPE,
  ESRCH,
  ESTALE,
  ETIME,
  ETIMEDOUT,
  ETXTBSY,
  EWOULDBLOCK,
  EXDEV,
  SIGABRT,
  SIGALRM,
  SIGBUS,
  SIGCHLD,
  SIGCONT,
  SIGFPE,
  SIGHUP,
  SIGILL,
  SIGINT,
  SIGIO,
  SIGIOT,
  SIGKILL,
  SIGPIPE,
  SIGPOLL,
  SIGPROF,
  SIGPWR,
  SIGQUIT,
  SIGSEGV,
  SIGSTKFLT,
  SIGSTOP,
  SIGSYS,
  SIGTERM,
  SIGTRAP,
  SIGTSTP,
  SIGTTIN,
  SIGTTOU,
  SIGURG,
  SIGUSR1,
  SIGUSR2,
  SIGVTALRM,
  SIGWINCH,
  SIGXCPU,
  SIGXFSZ,
  RTLD_DEEPBIND,
  RTLD_GLOBAL,
  RTLD_LAZY,
  RTLD_LOCAL,
  RTLD_NOW,
  PRIORITY_ABOVE_NORMAL,
  PRIORITY_BELOW_NORMAL,
  PRIORITY_HIGH,
  PRIORITY_HIGHEST,
  PRIORITY_LOW,
  PRIORITY_NORMAL,
  UV_DIRENT_BLOCK,
  UV_DIRENT_CHAR,
  UV_DIRENT_DIR,
  UV_DIRENT_FIFO,
  UV_DIRENT_FILE,
  UV_DIRENT_LINK,
  UV_DIRENT_SOCKET,
  UV_DIRENT_UNKNOWN,
  UV_FS_COPYFILE_EXCL,
  UV_FS_COPYFILE_FICLONE,
  UV_FS_COPYFILE_FICLONE_FORCE,
  UV_FS_O_FILEMAP,
  UV_FS_SYMLINK_DIR,
  UV_FS_SYMLINK_JUNCTION,
  COPYFILE_EXCL,
  COPYFILE_FICLONE,
  COPYFILE_FICLONE_FORCE,
  OPENSSL_VERSION_NUMBER,
  SSL_OP_ALL,
  SSL_OP_ALLOW_NO_DHE_KEX,
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
  SSL_OP_CIPHER_SERVER_PREFERENCE,
  SSL_OP_CISCO_ANYCONNECT,
  SSL_OP_COOKIE_EXCHANGE,
  SSL_OP_CRYPTOPRO_TLSEXT_BUG,
  SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS,
  SSL_OP_LEGACY_SERVER_CONNECT,
  SSL_OP_NO_COMPRESSION,
  SSL_OP_NO_ENCRYPT_THEN_MAC,
  SSL_OP_NO_QUERY_MTU,
  SSL_OP_NO_RENEGOTIATION,
  SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION,
  SSL_OP_NO_SSLv2,
  SSL_OP_NO_SSLv3,
  SSL_OP_NO_TICKET,
  SSL_OP_NO_TLSv1,
  SSL_OP_NO_TLSv1_1,
  SSL_OP_NO_TLSv1_2,
  SSL_OP_NO_TLSv1_3,
  SSL_OP_PRIORITIZE_CHACHA,
  SSL_OP_TLS_ROLLBACK_BUG,
  TLS1_1_VERSION,
  TLS1_2_VERSION,
  TLS1_3_VERSION,
  TLS1_VERSION,
  DH_CHECK_P_NOT_PRIME,
  DH_CHECK_P_NOT_SAFE_PRIME,
  DH_NOT_SUITABLE_GENERATOR,
  DH_UNABLE_TO_CHECK_GENERATOR,
  RSA_NO_PADDING,
  RSA_PKCS1_OAEP_PADDING,
  RSA_PKCS1_PADDING,
  RSA_PKCS1_PSS_PADDING,
  RSA_PSS_SALTLEN_AUTO,
  RSA_PSS_SALTLEN_DIGEST,
  RSA_PSS_SALTLEN_MAX_SIGN,
  RSA_SSLV23_PADDING,
  RSA_X931_PADDING,
  POINT_CONVERSION_COMPRESSED,
  POINT_CONVERSION_HYBRID,
  POINT_CONVERSION_UNCOMPRESSED,
  defaultCipherList,
  defaultCoreCipherList,
};
Object.freeze(constants);
export default constants;
