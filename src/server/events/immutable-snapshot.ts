const owned = new WeakSet<object>()

export function immutableSnapshot<T>(value: T): T {
  if (typeof value === 'number' && !Number.isFinite(value)) return null as T
  if (value === null || typeof value !== 'object') return value
  if (owned.has(value)) return value
  if (Array.isArray(value)) {
    const result = Array.from(value, (item) => immutableSnapshot(item === undefined ? null : item))
    Object.freeze(result)
    owned.add(result)
    return result as T
  }
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
      .map(([key, item]) => [key, immutableSnapshot(item)]),
  )
  Object.freeze(result)
  owned.add(result)
  return result as T
}
