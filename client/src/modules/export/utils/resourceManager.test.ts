import { describe, expect, it, vi } from 'vitest'
import { ResourceManager } from './resourceManager'

describe('ResourceManager', () => {
  it('disposes resources in reverse acquisition order', async () => {
    const order: string[] = []
    const manager = new ResourceManager()
    manager.add('first', () => {
      order.push('first')
    })
    manager.add('second', () => {
      order.push('second')
    })
    await manager.disposeAll()
    expect(order).toEqual(['second', 'first'])
    expect(manager.size).toBe(0)
  })

  it('continues disposing when one disposer throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const order: string[] = []
    const manager = new ResourceManager()
    manager.add('a', () => {
      order.push('a')
    })
    manager.add('bad', () => {
      throw new Error('boom')
    })
    manager.add('b', () => {
      order.push('b')
    })
    await manager.disposeAll()
    expect(order).toEqual(['b', 'a'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('supports early release without double-disposing', async () => {
    const dispose = vi.fn()
    const manager = new ResourceManager()
    const release = manager.add('one', dispose)
    await release()
    await release()
    await manager.disposeAll()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
