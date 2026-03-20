import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '@core/event-bus.js'
import type { BusEvent } from '@core/event-bus.js'

describe('EventBus', () => {
  it('should_broadcast_event_to_all_subscribers', () => {
    const bus = new EventBus()
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    bus.on(handler1)
    bus.on(handler2)
    const event: BusEvent = { type: 'user_input', text: 'hello', source: 'cli' }
    bus.emit(event)
    expect(handler1).toHaveBeenCalledWith(event)
    expect(handler2).toHaveBeenCalledWith(event)
  })

  it('should_unsubscribe_when_off_called', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const off = bus.on(handler)
    bus.emit({ type: 'user_input', text: 'a', source: 'cli' })
    expect(handler).toHaveBeenCalledTimes(1)
    off()
    bus.emit({ type: 'user_input', text: 'b', source: 'cli' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('should_filter_by_event_type', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.onType('user_input', handler)
    bus.emit({ type: 'user_input', text: 'hello', source: 'cli' })
    bus.emit({ type: 'text', text: 'world' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ type: 'user_input', text: 'hello', source: 'cli' })
  })

  it('should_not_throw_when_handler_errors', () => {
    const bus = new EventBus()
    bus.on(() => { throw new Error('boom') })
    const handler2 = vi.fn()
    bus.on(handler2)
    bus.emit({ type: 'user_input', text: 'hello', source: 'cli' })
    expect(handler2).toHaveBeenCalledTimes(1)
  })

  it('should_track_connected_clients', () => {
    const bus = new EventBus()
    expect(bus.getClients()).toHaveLength(0)
    bus.emit({ type: 'client_connect', clientId: 'web-1', clientType: 'web' })
    expect(bus.getClients()).toHaveLength(1)
    expect(bus.getClients()[0]).toEqual({ clientId: 'web-1', clientType: 'web' })
    bus.emit({ type: 'client_disconnect', clientId: 'web-1' })
    expect(bus.getClients()).toHaveLength(0)
  })
})
