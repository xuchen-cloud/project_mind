// Rust canonicalize uses Windows verbatim paths; Node realpath uses drive/UNC
// paths. Normalize only those two filesystem namespaces, independent of host OS.
export function normalizeDirectory(value) {
 if(typeof value!=='string') return value;
 if(value.startsWith('\\\\?\\UNC\\')) return '\\\\'+value.slice(8);
 if(/^\\\\\?\\[A-Za-z]:\\/.test(value)) return value.slice(4);
 return value;
}
