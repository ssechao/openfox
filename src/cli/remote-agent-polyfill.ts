function defineGlobal(name: string, value: unknown): void {
  const g = globalThis as Record<string, unknown>
  if (g[name] === undefined) g[name] = value
}

class StubDOMMatrix {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0
}

class StubPath2D {}

class StubDOMRect {
  x = 0
  y = 0
  width = 0
  height = 0
}

class StubImageData {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.data = new Uint8ClampedArray(width * height * 4)
  }
}

defineGlobal('DOMMatrix', StubDOMMatrix)
defineGlobal('Path2D', StubPath2D)
defineGlobal('DOMRect', StubDOMRect)
defineGlobal('ImageData', StubImageData)
