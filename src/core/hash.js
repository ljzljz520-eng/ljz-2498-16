// 稳定的 32 位字符串哈希（FNV-1a）。同构运行于浏览器与 Node。
// 仅用于命中/节点标识，不做密码学用途。
export function fnv1a(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
