import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FiltersEngine } from '@ghostery/adblocker'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { createFilters } from '../src/backend'
import { createMockValleyApi } from './mock'

const rules = '||ads.example.test^\n@@||ads.example.test/allowed.js\nexample.test##.advert\n||example.test^$csp=script-src \'none\''
const bytes = (value: string): string => btoa(value)
let mock: ReturnType<typeof createMockValleyApi>
let network: { fetch: ReturnType<typeof vi.fn> }
let api: PluginBackendApi
beforeEach(() => {
  mock = createMockValleyApi({ manifest: { id: 'renamed-browser' } })
  network = { fetch: vi.fn(async () => ({ status: 200, headers: {}, bodyBase64: bytes(rules) })) }
  api = { data: mock.api.data, network, rpc: { handle: vi.fn(() => () => {}), emit: vi.fn() } } as unknown as PluginBackendApi
  vi.spyOn(FiltersEngine, 'fromLists').mockImplementation(async (fetch, urls) => FiltersEngine.parse(await (await fetch(urls[0])).text()))
})
afterEach(() => vi.restoreAllMocks())
const config = { profiles: [{ partition: 'persist:profile', enabled: true, rules: 'https://filters.example.test/list.txt', frequencyDays: 7 }] }
const request = { partition: 'persist:profile', url: 'https://ads.example.test/track.js', type: 'script', method: 'GET', sourceUrl: 'https://example.test' }

describe('package-owned browser filter engine', () => {
  it('blocks rules, honors exceptions, preserves main-frame navigation and CSP', async () => {
    const filters = createFilters(api)
    await filters.configure(config)
    expect(await filters.request(request)).toEqual({ cancel: true })
    expect(await filters.request({ ...request, url: 'https://ads.example.test/allowed.js' })).toEqual({ cancel: false })
    expect(await filters.request({ ...request, type: 'mainFrame' })).toEqual({})
    expect(await filters.request({ ...request, phase: 'response', type: 'mainFrame', url: 'https://example.test' })).toEqual({ appendResponseHeaders: { 'Content-Security-Policy': ["script-src 'none'"] } })
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps disabled profiles independent and returns cosmetic rules', async () => {
    const filters = createFilters(api)
    await filters.configure({ profiles: [...config.profiles, { ...config.profiles[0], partition: 'private', enabled: false }] })
    expect(await filters.request({ ...request, partition: 'private' })).toEqual({})
    expect(network.fetch).not.toHaveBeenCalled()
    const cosmetics = await filters.cosmetics({ partition: 'persist:profile', url: 'https://example.test', classes: ['advert'], initial: true })
    expect(cosmetics.styles).toContain('.advert')
  })

  it('reuses only owner-local cached lists after a new backend starts', async () => {
    const first = createFilters(api)
    await first.configure(config)
    await first.request(request)
    const second = createFilters(api)
    await second.configure(config)
    await second.request(request)
    expect(network.fetch).toHaveBeenCalledTimes(1)
    expect(await mock.api.data.files.list('filter-cache')).toHaveLength(1)
  })

  it('validates package RPC payloads before opening a network connection', async () => {
    const filters = createFilters(api)
    await expect(filters.configure({ ...config, extra: true })).rejects.toThrow()
    await expect(filters.request({ ...request, url: 'not a URL' })).rejects.toThrow()
    expect(network.fetch).not.toHaveBeenCalled()
  })
})
