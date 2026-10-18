import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vitest globals are off, so RTL cannot auto-detect afterEach — wire it explicitly
afterEach(() => {
  cleanup()
})

// jsdom does not implement PointerEvent used by drag interactions
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerType: string
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
      this.pointerType = params.pointerType ?? 'mouse'
    }
  }
  // @ts-expect-error tests environment polyfill
  globalThis.PointerEvent = PointerEventPolyfill
}

if (typeof globalThis.matchMedia === 'undefined') {
  const stub = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
  Object.defineProperty(globalThis, 'matchMedia', { value: stub, configurable: true, writable: true })
}
