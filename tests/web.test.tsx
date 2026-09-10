import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMockValleyApi } from './mock'
import { register } from '../src/index'
import { initRuntime } from '../src/runtime'
import { createStore, disposeStore, getStore, toUrl } from '../src/store'
import { clearWebContext, publishWebContext, requestWebNoteFromSelection } from '../src/webContext'
import { embedPresentation, registerWebFences, resolveProviderUrl } from '../src/embeds'
import { ensureEmbedProviders, loadEmbedProviders, customizeEmbedProvider, type EmbedProvider } from '../src/embedProviders'
import { BUILT_IN_PROVIDERS, embedRenderer, installRuntimeEmbedRenderers } from '../src/embeds/registry'
import {
  TEXT_SELECTION_ACTION_V1,
  METADATA_PANEL_SEGMENT_V1,
  PLUGIN_SURFACE_V1,
  WEB_ACTIVE_CONTEXT_V1,
  WEB_NAVIGATOR_V1,
  type MainWorkspaceViewProps
} from '@valley/plugin-sdk'
import {
  DEFAULT_SETTINGS,
  INCOGNITO_PROFILE_ID,
  normalizeProfile,
  normalizeSavedPage,
  normalizeSettings,
  partitionFor,
  searchUrl
} from '../src/profiles'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const youtubeProvider: EmbedProvider = {
  schemaVersion: 1,
  id: 'youtube',
  displayName: 'YouTube',
  language: 'youtube',
  template: 'https://www.youtube.com/embed/{value}',
  kind: 'youtube',
  valueParser: 'youtube-video-id',
  presentation: { initialHeight: 360, autoSize: false, fullWidth: true, aspectRatio: '16 / 9', httpReferrer: 'https://localhost/' },
  order: 10,
  directory: 'youtube'
}

const xProvider: EmbedProvider = {
  schemaVersion: 1,
  id: 'x',
  displayName: 'X',
  language: 'X',
  template: 'https://platform.twitter.com/embed/Tweet.html?id={value}',
  kind: 'x',
  valueParser: 'x-post-id',
  presentation: { initialHeight: 180, autoSize: true, fullWidth: true, minHeight: 180, maxHeight: 1200, fitWidth: { naturalWidth: 515, maxScale: 1.3 } },
  theme: { queryParameter: 'theme', values: { light: 'light', reading: 'light', dark: 'dark' } },
  order: 20,
  directory: 'x'
}

const providerFile = (provider: EmbedProvider): string => {
  const { directory: _directory, ...value } = provider
  return JSON.stringify(value)
}

describe('toUrl (address-bar URL vs query)', () => {
  it('passes a full URL through unchanged', () => {
    expect(toUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1')
    expect(toUrl('  http://localhost:3000/x ')).toBe('http://localhost:3000/x')
  })

  it('https-prefixes a bare domain', () => {
    expect(toUrl('example.com')).toBe('https://example.com')
    expect(toUrl('sub.example.co.uk/page')).toBe('https://sub.example.co.uk/page')
  })

  it('sends a plain query to the configured search engine', () => {
    expect(toUrl('fox habitat')).toBe(searchUrl('google', 'fox habitat'))
    expect(toUrl('fox habitat', 'duckduckgo')).toBe(searchUrl('duckduckgo', 'fox habitat'))
    expect(toUrl('fox habitat')).toMatch(/^https:\/\//)
  })

  it('returns empty for blank input', () => {
    expect(toUrl('   ')).toBe('')
  })
})

describe('web plugin', () => {
  it('loads the bundled provider definitions with their adjacent renderers', () => {
    expect(BUILT_IN_PROVIDERS.map((provider) => [provider.directory, provider.kind])).toEqual([
      ['youtube', 'youtube'],
      ['x', 'x']
    ])
    expect(embedRenderer('youtube').parseValue('https://youtu.be/M7lc1UVf-VE')).toBe('M7lc1UVf-VE')
    expect(embedRenderer('x').parseValue('https://x.com/jack/status/20')).toBe('20')
  })

  it('uses a runtime provider renderer ahead of the bundled fallback', () => {
    installRuntimeEmbedRenderers(new Map([['youtube', {
      ...embedRenderer('youtube'),
      parseValue: () => 'runtime-video'
    }]]))
    try {
      expect(resolveProviderUrl(youtubeProvider, 'https://youtu.be/M7lc1UVf-VE')).toBe(
        'https://www.youtube.com/embed/runtime-video'
      )
    } finally {
      installRuntimeEmbedRenderers(new Map())
    }
  })

  it('claims shared footer playback while an embed is playing', async () => {
    class ImmediateIntersectionObserver {
      readonly root = null
      readonly rootMargin = '0px'
      readonly thresholds = [0]
      constructor(private readonly callback: IntersectionObserverCallback) {}
      disconnect(): void {}
      observe(target: Element): void {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      takeRecords(): IntersectionObserverEntry[] { return [] }
      unobserve(): void {}
    }
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver)
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    initRuntime(mock.api)
    const offFences = registerWebFences(Promise.resolve({ providers: [youtubeProvider], customized: [], issues: [] }))
    let offEmbed: void | (() => void) = undefined
    try {
      await tick()
      const el = document.createElement('div')
      document.body.appendChild(el)
      offEmbed = mock.codeBlockRenderers.get('youtube')!(
        'https://www.youtube.com/watch?v=UF8uR6Z6KLc',
        el,
        { path: 'Research/Embed Demo.md', meta: null }
      )
      const webview = el.querySelector('.web-fence-body > div') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> }
      const executeJavaScript = vi.fn().mockResolvedValue({
        title: 'Steve Jobs introduces iPhone',
        playing: true,
        position: 12,
        duration: 240,
        volume: 0.8
      })
      webview.executeJavaScript = executeJavaScript
      webview.dispatchEvent(new Event('media-started-playing'))

      await waitFor(() => expect(mock.api.playback.getActive()).toMatchObject({
        id: expect.stringContaining('embed:Research/Embed Demo.md:'),
        path: 'Research/Embed Demo.md',
        title: 'Steve Jobs introduces iPhone',
        position: 12,
        duration: 240,
        isPlaying: true,
        canSkip: false
      }))
      mock.api.playback.getActive()?.toggle()
      expect(executeJavaScript.mock.calls.some(([code]) => String(code).includes('active.pause()'))).toBe(true)

      offEmbed?.()
      expect(mock.api.playback.getActive()).toBeNull()
    } finally {
      offEmbed?.()
      offFences()
      vi.unstubAllGlobals()
      cleanup()
    }
  })

  it('renders fixed browser profile facts as Markdown rows, without disabled inputs', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    try {
      const segment = api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)
        .find((provider) => provider.extension.id === 'surfing.profileProperties')!.extension
      const subject = { pluginId: 'surfing', surface: 'main_workspace' as const, view: { profileId: INCOGNITO_PROFILE_ID } }
      const { container } = render(React.createElement(React.Fragment, null, segment.render({ relPath: '', kind: 'unsupported', subject })))
      expect(await screen.findByText(INCOGNITO_PROFILE_ID, { selector: 'dd' })).toHaveClass('props-info-value')
      expect(screen.getByText('false')).toBeTruthy()
      expect([...container.querySelectorAll('.props-info-key')].map((element) => element.textContent)).toEqual(['Profile', 'Private', 'Hidden'])
      expect(container.querySelectorAll('.props-info-row')).toHaveLength(3)
      expect(container.querySelector('input, button, select')).not.toBeInTheDocument()
    } finally { cleanup(); dispose() }
  })

  it('restores explicit page and profile targets without focus, preserves private URLs, and returns structured browser results', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    const store = getStore()!
    const surface = api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    await surface.restore({ profileId: 'default', url: 'https://example.test/forest', title: 'Forest' }, 'saved-tab', { background: true })
    expect(store.getTab('saved-tab')).toMatchObject({ profileId: 'default', url: 'https://example.test/forest', title: 'Forest' })
    expect(api.workspace.openMainTab).not.toHaveBeenCalled()
    const snapshot = surface.getSnapshot('saved-tab')
    expect(snapshot?.item?.state).toMatchObject({ url: 'https://example.test/forest', profileId: 'default' })
    expect(snapshot?.bookmarkTargets).toEqual({ item: false })
    expect(snapshot?.actions?.[0]).toMatchObject({ id: 'reading-list', label: 'Add page to Reading list' })
    await snapshot?.actions?.[0].onSelect?.()
    expect(store.getSnapshot().readingList.map((page) => page.url)).toContain('https://example.test/forest')
    await expect(surface.restore({ profileId: 'deleted', url: 'https://example.test/forest' }, 'saved-tab')).rejects.toThrow('no longer exists')
    expect(store.getTab('saved-tab')?.profileId).toBe('default')
    await surface.restore({ profileId: INCOGNITO_PROFILE_ID, url: 'https://private.example.test/' }, 'private-tab', { background: true })
    store.navigate('private-tab', 'https://private.example.test/')
    expect(surface.getSnapshot('private-tab')?.item).toBeUndefined()
    const opened = await api.commands.executeOwn('browser-open-tab', { url: 'https://example.test/meadow' })
    expect(opened).toMatchObject({ ok: true, value: { instanceId: expect.any(String), url: 'https://example.test/meadow' } })
    expect(await api.commands.executeOwn('browser-list-tabs')).toMatchObject({ ok: true, value: { tabs: expect.any(Array) } })
    expect(await api.commands.executeOwn('browser-close-tab', { instanceId: 'deleted-tab' })).toMatchObject({ ok: false })
    expect(await api.commands.executeOwn('clip', {})).toMatchObject({ ok: false, error: { message: expect.stringContaining('instanceId is required') } })
    dispose()
  })

  it('registers its workspace + panel views via register(api)', () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    const keys = (api.registerView as unknown as { mock: { calls: [string, unknown][] } }).mock.calls.map(
      (c) => c[0]
    )
    expect(keys).toContain('surfing.page')
    expect(keys).toContain('surfing.panel')
    dispose()
  })

  it('disposing register clears the session runtime store', () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    expect(getStore()).not.toBeNull()
    dispose()
    expect(getStore()).toBeNull()
  })

  it('registers a host new-tab handler that creates a web tab', async () => {
    const { api, newTabHandlers } = createMockValleyApi()
    const dispose = register(api)
    await waitFor(() => expect(newTabHandlers).toHaveLength(1))
    await newTabHandlers[0]!({ paneId: 'pane-right' })
    expect(Object.keys(getStore()!.getSnapshot().tabs)).toHaveLength(1)
    expect(api.workspace.openMainTab).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'pane-right',
      newTab: true
    }))
    dispose()
    expect(newTabHandlers).toHaveLength(0)
  })

  it('unregisters the website new-tab handler when the General setting is off', async () => {
    const { api, newTabHandlers } = createMockValleyApi()
    const dispose = register(api)
    await waitFor(() => expect(newTabHandlers).toHaveLength(1))
    act(() => getStore()!.setSetting('openWebsiteOnNewTab', false))
    expect(newTabHandlers).toHaveLength(0)
    act(() => getStore()!.setSetting('openWebsiteOnNewTab', true))
    expect(newTabHandlers).toHaveLength(1)
    dispose()
  })

  it('shows the actual tab profile in the website toolbar', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const store = getStore()!
    store.renameProfile('default', 'Canopy')
    store.setProfileIcon('default', 'leaf')
    const instanceId = store.openTab('example.com', 'default')
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType<MainWorkspaceViewProps>][] } }).mock.calls
      .find(([id]) => id === 'surfing.page')
    render(React.createElement(call![1], { instanceId, navigation: { setController: vi.fn() } }))
    const profile = screen.getByLabelText('Profile: Canopy')
    expect(profile).toHaveTextContent('Canopy')
    const toolbar = profile.closest('.web-toolbar')!
    expect(toolbar.children[0]).toBe(profile)
    expect(toolbar.children[1]).toHaveClass('web-address')
    expect(toolbar.children[2]).toHaveClass('web-nav-group')
    expect(toolbar.children[3]).toHaveClass('web-star')
    cleanup()
    dispose()
  })

  it('uses eyeglasses for the Reading list tab', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
      .find(([id]) => id === 'surfing.panel')
    render(React.createElement(call![1]))
    const reading = screen.getByTitle('Reading list')
    expect(reading.querySelectorAll('circle')).toHaveLength(2)
    cleanup()
    dispose()
  })

  it('requires Cancel or Clear confirmation before clearing History', async () => {
    const { api, confirmations } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const store = getStore()!
    const tab = store.openTab('')
    store.reportUrl(tab, 'https://history.example/')
    await waitFor(() => expect(store.getSnapshot().history).toHaveLength(1))
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
      .find(([id]) => id === 'surfing.panel')
    render(React.createElement(call![1]))
    fireEvent.click(screen.getByTitle('Timeline'))
    const clear = await screen.findByRole('button', { name: 'Clear' })

    fireEvent.click(clear)
    await waitFor(() => expect(confirmations).toHaveLength(1))
    expect(confirmations[0]).toMatchObject({
      title: 'Clear history?',
      actions: [
        { label: 'Cancel', value: 'cancel', variant: 'ghost' },
        { label: 'Clear', value: 'clear', variant: 'danger' }
      ]
    })
    expect(store.getSnapshot().history).toHaveLength(1)

    ;(api.ui.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce('clear')
    fireEvent.click(clear)
    await waitFor(() => expect(store.getSnapshot().history).toHaveLength(0))
    cleanup()
    dispose()
  })

  it('provides separate Profile and Website metadata tabs', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    await tick()
    const store = getStore()!
    const instanceId = store.openTab('example.com', 'default')
    store.restoreTab(instanceId, {
      url: 'https://example.com/',
      title: 'Example',
      profileId: 'default',
      metadata: {
        description: 'A useful example page.',
        image: 'https://example.com/share.jpg',
        siteName: 'Example site',
        icon: 'https://example.com/favicon.ico',
        canonical: 'https://example.com/canonical',
        language: 'en-CH'
      }
    })
    const subject = {
      pluginId: 'surfing',
      surface: 'main_workspace' as const,
      instanceId: 'stale-instance',
      view: { profileId: 'default' },
      item: { id: 'page', title: 'Example', state: { profileId: 'default', url: 'https://example.com/' } }
    }
    const segments = api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).map((provider) => provider.extension)
    expect(segments.map((segment) => ({ id: segment.id, icon: segment.icon }))).toEqual([
      { id: 'surfing.websiteProperties', icon: 'globe' },
      { id: 'surfing.profileProperties', icon: 'user' }
    ])
    expect(await segments[1].inspect!({ relPath: '', kind: 'unsupported', subject })).toEqual([
      expect.objectContaining({ id: 'profileId', value: 'default', readOnly: true }),
      expect.objectContaining({ id: 'private', value: false, readOnly: true }),
      expect.objectContaining({ id: 'hidden', value: 'false', readOnly: true })
    ])
    expect((await segments[0].inspect!({ relPath: '', kind: 'unsupported', subject })).map((field) => field.id)).toEqual([
      'title', 'url', 'security', 'icon', 'iconUrl', 'language'
    ])
    const websiteFields = await segments[0].inspect!({ relPath: '', kind: 'unsupported', subject })
    expect(websiteFields.every((field) => field.readOnly === true)).toBe(true)
    expect(websiteFields.find((field) => field.id === 'security')).toMatchObject({ value: 'Secure' })
    const { container } = render(React.createElement(React.Fragment, null, segments[0].render({ relPath: '', kind: 'unsupported', subject })))
    expect(await screen.findByText('Example')).toBeTruthy()
    expect(screen.getByText('https://example.com/')).toBeTruthy()
    expect(screen.getByText('Secure')).toBeTruthy()
    expect(screen.getByText('https://example.com/favicon.ico')).toBeTruthy()
    expect(screen.getByText('en-CH')).toBeTruthy()
    expect(container.querySelector('.web-metadata-icon img')).toHaveAttribute('src', 'https://example.com/favicon.ico')
    expect(container.querySelector('input, button, select')).not.toBeInTheDocument()
    cleanup()
    dispose()
  })

  it('opens a new website tab in the selected profile without changing the open page', async () => {
    const { api, menus } = createMockValleyApi()
    const dispose = register(api)
    await tick()
    const store = getStore()!
    const original = store.openTab('example.com', 'default')
    const profileId = store.addProfile('Fungi')
    publishWebContext({ instanceId: original, url: 'https://example.com', title: 'Example' })
    const call = (api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
      .find(([id]) => id === 'surfing.panel')
    render(React.createElement(call![1]))
    fireEvent.click(document.querySelector('.web-profile-btn')!)
    const item = menus.at(-1)?.find((entry) => entry.id === profileId)
    await act(async () => {
      item?.onSelect?.()
      await tick()
    })

    expect(store.getSnapshot().activeProfileId).toBe(profileId)
    expect(store.getTab(original)?.profileId).toBe('default')
    const created = Object.entries(store.getSnapshot().tabs).find(([id]) => id !== original)
    expect(created?.[1].profileId).toBe(profileId)
    expect(api.workspace.openMainTab).toHaveBeenLastCalledWith(expect.objectContaining({
      instanceId: created?.[0],
      newTab: true
    }))
    act(() => clearWebContext(original))
    cleanup()
    dispose()
  })

  it('loads built-in providers from the package without creating saved source files', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'surfing' } })
    initRuntime(mock.api)
    const configuration = await ensureEmbedProviders()

    expect(configuration.providers.map((provider) => provider.id)).toEqual(['youtube', 'x'])
    expect(configuration.customized).toEqual([])
    for (const id of ['youtube', 'x']) {
      expect(await mock.api.data.files.readText(`embeds/${id}/provider.json`)).toBeNull()
      expect(await mock.api.data.files.readText(`embeds/${id}/renderer.tsx`)).toBeNull()
    }
    await customizeEmbedProvider(configuration.providers[0])
    expect(await mock.api.data.files.readText('embeds/youtube/provider.json')).toContain('"id": "youtube"')
    expect(await mock.api.data.files.readText('embeds/youtube/renderer.tsx')).toContain('kind: "youtube"')
    expect(await mock.api.data.files.readText('embeds/x/provider.json')).toBeNull()
  })

  it('retains saved overrides and uses package defaults without writing missing files', async () => {
    const mock = createMockValleyApi({
      manifest: { id: 'surfing' },
      files: {
        '.valley/plugins/data/surfing/embeds/youtube/provider.json': providerFile({
          ...youtubeProvider,
          template: 'https://custom.example/{value}',
          kind: 'generic',
          valueParser: 'identity'
        })
      }
    })
    initRuntime(mock.api)
    const configuration = await ensureEmbedProviders()
    expect(configuration.providers).toHaveLength(2)
    expect(configuration.providers[0]).toMatchObject({ id: 'youtube', template: 'https://custom.example/{value}' })
    expect(await mock.api.data.files.readText('embeds/youtube/renderer.tsx')).toBeNull()
    expect(configuration.customized).toEqual(['youtube'])
    expect(await mock.api.data.files.readText('embeds/x/provider.json')).toBeNull()

    expect(resolveProviderUrl(xProvider, 'https://x.com/jack/status/20', 'reading')).toBe('https://platform.twitter.com/embed/Tweet.html?id=20&theme=light')
    expect(resolveProviderUrl(xProvider, 'https://x.com/jack/status/20', 'dark')).toBe('https://platform.twitter.com/embed/Tweet.html?id=20&theme=dark')
    expect(resolveProviderUrl({ ...xProvider, kind: 'generic' }, 'https://x.com/jack/status/20', 'dark')).toBe('https://platform.twitter.com/embed/Tweet.html?id=20&theme=dark')
    expect(embedPresentation('https://www.youtube.com/embed/UF8uR6Z6KLc')).toEqual({
      height: 360,
      autoSize: false,
      httpReferrer: 'https://localhost/'
    })
    expect(embedPresentation('https://platform.twitter.com/embed/Tweet.html?id=20')).toEqual({
      height: 180,
      autoSize: true
    })
    expect(embedPresentation('https://platform.twitter.com/embed/Tweet.html?id=20', 500)).toEqual({
      height: 500,
      autoSize: false
    })
    const dispose = registerWebFences(Promise.resolve({ providers: [xProvider], customized: [], issues: [] }))
    await tick()
    expect(mock.codeBlockRenderers.has('twitter')).toBe(false)
    expect(mock.codeBlockRenderers.has('x')).toBe(true)
    dispose()
  })

  it('rejects invalid provider definitions without hiding valid providers', async () => {
    const mock = createMockValleyApi({
      manifest: { id: 'surfing' },
      files: {
        '.valley/plugins/data/surfing/embeds/youtube/provider.json': providerFile(youtubeProvider),
        '.valley/plugins/data/surfing/embeds/unsafe/provider.json': JSON.stringify({ schemaVersion: 1, id: 'unsafe', displayName: 'Unsafe', language: 'surfing', template: 'javascript:{value}', kind: 'generic', valueParser: 'identity', presentation: { initialHeight: 360, autoSize: false, fullWidth: true }, order: 30 })
      }
    })
    initRuntime(mock.api)
    const configuration = await loadEmbedProviders()
    expect(configuration.providers.map((provider) => provider.id)).toEqual(['youtube', 'x'])
    expect(configuration.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.valley/plugins/data/surfing/embeds/unsafe/provider.json' })
    ]))
  })

  it('forwards web-navigator new-tab intent to workspace placement', async () => {
    const { api } = createMockValleyApi()
    const dispose = register(api)
    const [navigator] = api.interop.services.providers(WEB_NAVIGATOR_V1)

    expect(
      await navigator.invoke('open', [
        { url: 'https://example.com/docs', title: 'Docs', newTab: true }
      ])
    ).toMatchObject({ ok: true })
    expect(api.workspace.openMainTab).toHaveBeenCalledWith({
      instanceId: expect.any(String),
      title: 'Docs',
      newTab: true
    })
    dispose()
  })

  it('registers the web:open/switch/close command bus and opens a tab on web:open', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    const ids = api.commands.list().map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining(['surfing:open', 'surfing:switch', 'surfing:close']))
    const res = await api.commands.execute('surfing:open', { url: 'example.com' })
    expect(res.ok).toBe(true)
    expect(Object.keys(getStore()!.getSnapshot().tabs)).toHaveLength(1)
    dispose()
  })

  it('enforces the normal-profile invariant through the plugin command API', async () => {
    const { api } = createMockValleyApi({ manifest: { id: 'surfing' } })
    const dispose = register(api)
    const created = await api.commands.executeOwn('create-profile', { name: 'Fungi' })
    expect(created).toMatchObject({ ok: true, value: { name: 'Fungi' } })
    const fungi = getStore()!.getSnapshot().profiles.find((profile) => profile.name === 'Fungi')!

    expect(await api.commands.executeOwn('delete-profile', { profileId: 'default' })).toMatchObject({ ok: true })
    expect(await api.commands.executeOwn('delete-profile', { profileId: fungi.id })).toMatchObject({
      ok: false,
      error: { message: 'At least one normal browser profile must remain.' }
    })

    dispose()
  })
})

describe('web store (one site per tab)', () => {
  it('keeps a stale hot-reload disposer from tearing down the replacement store', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    const first = createStore(api)
    const second = createStore(api)
    disposeStore(api, first)
    expect(getStore()).toBe(second)
    disposeStore(api, second)
    expect(getStore()).toBeNull()
  })

  it('openTab creates a distinct per-instance tab with a normalized url', () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const a = store.openTab('example.com')
    const b = store.openTab('other.com')
    expect(a).not.toBe(b)
    expect(store.getTab(a)?.url).toBe('https://example.com')
    expect(Object.keys(store.getSnapshot().tabs)).toHaveLength(2)
  })

  it('navigate/setTitle mutate only the addressed tab', () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const a = store.openTab('a.com')
    const b = store.openTab('b.com')
    store.setTitle(a, 'Alpha')
    store.navigate(b, 'b.org')
    expect(store.getTab(a)?.title).toBe('Alpha')
    expect(store.getTab(a)?.url).toBe('https://a.com')
    expect(store.getTab(b)?.title).toBe('')
    expect(store.getTab(b)?.url).toBe('https://b.org')
  })

  it('closeTab removes a single tab', () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const a = store.openTab('a.com')
    const b = store.openTab('b.com')
    store.closeTab(a)
    expect(store.getTab(a)).toBeUndefined()
    expect(store.getTab(b)).toBeDefined()
  })
})

describe('web store (open-tab persistence across reload)', () => {
  it('loadConfig restores the page each persisted tab was showing', async () => {
    const { api } = createMockValleyApi({
      datasets: {
        'surfing.tabs': [
          { id: 'web-1', url: 'https://news.example', title: 'News', profileId: 'default' },
          { id: 'web-2', url: 'https://docs.example', title: 'Docs', profileId: 'gone' }
        ]
      }
    })
    const store = createStore(api)
    await store.loadConfig()
    expect(store.getTab('web-1')?.url).toBe('https://news.example')
    expect(store.getTab('web-1')?.title).toBe('News')
    // A tab whose profile no longer exists falls back to the default profile.
    expect(store.getTab('web-2')?.url).toBe('https://docs.example')
    expect(store.getTab('web-2')?.profileId).toBe('default')
  })

  it('a tab the user already navigated is not clobbered by the saved page', async () => {
    const { api } = createMockValleyApi({
      datasets: { 'surfing.tabs': [{ id: 'web-1', url: 'https://old.example', title: '', profileId: 'default' }] }
    })
    const store = createStore(api)
    // Page mounted + user navigated before the async restore landed.
    store.ensureTab('web-1')
    store.navigate('web-1', 'fresh.example')
    await store.loadConfig()
    expect(store.getTab('web-1')?.url).toBe('https://fresh.example')
  })

  it('persists open tabs to disk so a reload can reopen them', async () => {
    vi.useFakeTimers()
    try {
      const { api, datasets } = createMockValleyApi()
      const store = createStore(api)
      await store.loadConfig() // arms persistence
      const a = store.openTab('example.com')
      store.reportUrl(a, 'https://example.com/article')
      await vi.advanceTimersByTimeAsync(500) // flush the debounced write
      const saved = datasets.get('surfing.tabs') ?? []
      expect(saved).toEqual([{ id: a, url: 'https://example.com/article', title: '', profileId: 'default' }])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('web active-context interop', () => {
  it('publishes the typed active context and notifies subscribers', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    let notifications = 0
    const off = api.interop.state.subscribe(WEB_ACTIVE_CONTEXT_V1, () => notifications++)
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test/p', title: 'A' })
    expect(api.interop.state.get(WEB_ACTIVE_CONTEXT_V1)).toEqual({
      instanceId: 'web-1',
      url: 'https://a.test/p',
      title: 'A'
    })
    expect(notifications).toBe(1)
    off()
  })

  it('publishWebContext is idempotent — no publish when nothing changed', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    let count = 0
    const off = api.interop.state.subscribe(WEB_ACTIVE_CONTEXT_V1, () => count++)
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test/p', title: 'A' })
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test/p', title: 'A' })
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test/p', title: 'A2' })
    expect(count).toBe(2) // first publish + the title change
    off()
  })

  it('clearWebContext only clears when the instance still owns the context', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    publishWebContext({ instanceId: 'web-1', url: 'https://a.test', title: '' })
    publishWebContext({ instanceId: 'web-2', url: 'https://b.test', title: '' })
    // web-1 was already superseded by web-2 → its clear is a no-op.
    clearWebContext('web-1')
    expect(api.interop.state.get(WEB_ACTIVE_CONTEXT_V1)).toMatchObject({ instanceId: 'web-2' })
    clearWebContext('web-2')
    expect(api.interop.state.get(WEB_ACTIVE_CONTEXT_V1)).toBeNull()
  })

  it('routes selected text through a typed extension provider', () => {
    const { api } = createMockValleyApi()
    initRuntime(api)
    const run = vi.fn()
    api.interop.extensions.provide(TEXT_SELECTION_ACTION_V1, {
      id: 'forest-note',
      labelKey: 'sidenotes.create',
      label: 'Create note',
      surfaces: ['web'],
      run
    })
    requestWebNoteFromSelection('https://a.test/p', '  picked text  ')
    expect(run).toHaveBeenCalledWith({ surface: 'web', url: 'https://a.test/p', text: 'picked text' })
  })
})

describe('web store (selection capture)', () => {
  it('getSelectionText reads + trims the guest selection, and is safe when absent', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    ;(store as unknown as { views: Map<string, unknown> }).views.set('web-1', {
      executeJavaScript: vi.fn().mockResolvedValue('  selected words  ')
    })
    expect(await store.getSelectionText('web-1')).toBe('selected words')
    // Unknown tab → empty string, never throws.
    expect(await store.getSelectionText('missing')).toBe('')
  })

  it('keeps public tab ids out of the browser driver and acts through its opaque handle', async () => {
    const mock = createMockValleyApi()
    const store = createStore(mock.api)
    store.ensureTab('web-1')
    const guestId = crypto.randomUUID()
    vi.spyOn(mock.api.drivers.browser, 'list').mockResolvedValue({ ok: true, data: { guests: [{ guestId, url: 'https://example.test', title: 'Fixture' }] } })
    store.readyGuest('web-1', { type: 'ready', guestId, url: 'https://example.test' })
    const listed = await store.listBrowserTabs()
    await store.browserSnapshot('web-1')

    expect(listed.data?.tabs.map((tab) => tab.instanceId)).toEqual(['web-1'])
    expect(mock.driverCalls.some((call) => call.method === 'register')).toBe(false)
    const payload = mock.driverCalls.find((call) => call.method === 'execute')?.payload as { guestId?: string }
    expect(payload.guestId).toBe(guestId)
    expect(payload.guestId).not.toBe('web-1')
    store.dispose()
  })
})

describe('toUrl (address-bar normalization)', () => {
  it('keeps explicit schemes', () => {
    expect(toUrl('https://x.com/a')).toBe('https://x.com/a')
    expect(toUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })
  it('https-prefixes a bare domain', () => {
    expect(toUrl('example.com')).toBe('https://example.com')
    expect(toUrl('news.ycombinator.com/news')).toBe('https://news.ycombinator.com/news')
  })
  it('treats free text as a web search', () => {
    expect(toUrl('hello world')).toBe('https://www.google.com/search?q=hello%20world')
  })
  it('searches with the chosen engine', () => {
    expect(toUrl('hello', 'duckduckgo')).toBe('https://duckduckgo.com/?q=hello')
  })
})

describe('profiles (pure helpers)', () => {
  it('partitionFor isolates each profile (and the default)', () => {
    expect(partitionFor('default')).toBe('persist:web-default')
    expect(partitionFor('p-abc')).toBe('persist:web_p-abc')
    expect(partitionFor('a')).not.toBe(partitionFor('b'))
  })

  it('searchUrl encodes per engine and falls back to google', () => {
    expect(searchUrl('google', 'a b')).toBe('https://www.google.com/search?q=a%20b')
    expect(searchUrl('bing', 'x')).toBe('https://www.bing.com/search?q=x')
    expect(searchUrl('duckduckgo', 'x')).toBe('https://duckduckgo.com/?q=x')
    expect(searchUrl('baidu', 'a b')).toBe('https://www.baidu.com/s?wd=a%20b')
    expect(searchUrl('yahoo', 'a b')).toBe('https://search.yahoo.com/search?p=a%20b')
    expect(searchUrl('nope' as 'google', 'x')).toContain('google.com')
  })

  it('normalizeSettings fills defaults and rejects invalid values', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
    const n = normalizeSettings({ searchEngine: 'bogus', adblockFrequency: -5, homepage: 42 })
    expect(n.searchEngine).toBe('google')
    expect(n.homepage).toBe('')
    const m = normalizeSettings({ searchEngine: 'duckduckgo', adblockEnabled: false })
    expect(m.searchEngine).toBe('duckduckgo')
    expect(m).not.toHaveProperty('adblockEnabled')
  })

  it('normalizeProfile drops id-less records and defaults the name to the id', () => {
    expect(normalizeProfile({ id: '', name: 'x' })).toBeNull()
    expect(normalizeProfile({ name: 'x' })).toBeNull()
    expect(normalizeProfile({ id: 'p1' })?.name).toBe('p1')
    expect(normalizeProfile({ id: 'p1', name: 'Fungi' })?.name).toBe('Fungi')
  })
})

describe('web store (profiles + active)', () => {
  it('adds, renames, switches active, and deletes profiles', async () => {
    const { api, driverCalls } = createMockValleyApi()
    const store = createStore(api)
    const id = store.addProfile('Fungi')
    expect(store.getSnapshot().profiles.map((p) => p.name)).toContain('Fungi')
    expect(store.getSnapshot().profiles.some((p) => p.id === 'default')).toBe(true)
    expect(store.getSnapshot().profiles.some((p) => p.id === INCOGNITO_PROFILE_ID)).toBe(true)

    store.renameProfile(id, 'Job')
    expect(store.getSnapshot().profiles.find((p) => p.id === id)?.name).toBe('Job')

    store.setActiveProfile(id)
    expect(store.getSnapshot().activeProfileId).toBe(id)

    await store.deleteProfile(id)
    expect(store.getSnapshot().profiles.find((p) => p.id === id)).toBeUndefined()
    expect(store.getSnapshot().activeProfileId).toBe('default')
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(['default', INCOGNITO_PROFILE_ID])
    expect(driverCalls).toContainEqual(expect.objectContaining({
      driver: 'browser',
      method: 'clearData',
      payload: { partition: partitionFor(id) }
    }))
  })

  it('protects the last normal profile and always protects Incognito', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.deleteProfile('default')
    await store.deleteProfile(INCOGNITO_PROFILE_ID)
    expect(store.getSnapshot().profiles.some((p) => p.id === 'default')).toBe(true)
    expect(store.getSnapshot().profiles.some((p) => p.id === INCOGNITO_PROFILE_ID)).toBe(true)
  })

  it('keeps Default beside custom profiles and allows deleting either while another remains', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const fungi = store.addProfile('Fungi')
    const plants = store.addProfile('Plants')

    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(['default', fungi, plants, INCOGNITO_PROFILE_ID])

    await store.deleteProfile('default')
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([fungi, plants, INCOGNITO_PROFILE_ID])

    await store.deleteProfile(fungi)
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([plants, INCOGNITO_PROFILE_ID])
    await store.deleteProfile(plants)
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual([plants, INCOGNITO_PROFILE_ID])
  })

  it('moves open tabs to the replacement normal profile', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const fungi = store.addProfile('Fungi')
    const tab = store.openTab('example.com', fungi)
    expect(store.getTab(tab)?.profileId).toBe(fungi)

    await store.deleteProfile(fungi)
    expect(store.getTab(tab)?.profileId).toBe('default')
  })
})

describe('web store (per-profile history)', () => {
  it('appends, dedupes consecutive same-url visits, and clears', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const a = store.openTab('')
    const b = store.openTab('')
    store.reportUrl(a, 'https://news.example')
    store.reportUrl(b, 'https://news.example') // same url, same (default) profile → deduped
    store.reportUrl(a, 'https://other.example')

    const hist = await store.readHistory('default')
    expect(hist.map((e) => e.url)).toEqual(['https://other.example', 'https://news.example'])

    await store.clearHistory('default')
    expect(await store.readHistory('default')).toHaveLength(0)
  })

  it('keeps history isolated per profile', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const fungi = store.addProfile('Fungi')
    store.setActiveProfile(fungi)
    const t = store.openTab('')
    store.reportUrl(t, 'https://fungi.example')

    expect((await store.readHistory(fungi)).map((e) => e.url)).toEqual(['https://fungi.example'])
    expect(await store.readHistory('default')).toHaveLength(0)
  })
})

describe('saved-page helpers + permanent Incognito profile', () => {
  it('normalizeSavedPage drops url-less records and defaults title/ts', () => {
    expect(normalizeSavedPage({})).toBeNull()
    expect(normalizeSavedPage({ title: 'x' })).toBeNull()
    expect(normalizeSavedPage({ url: 'https://a.test' })).toEqual({ url: 'https://a.test', title: '', ts: 0 })
    expect(normalizeSavedPage({ url: 'https://a.test', title: 'A', ts: 5 })).toEqual({ url: 'https://a.test', title: 'A', ts: 5 })
  })

  it('normalizeProfile carries the private flag', () => {
    expect(normalizeProfile({ id: 'p1' })?.private).toBeUndefined()
    expect(normalizeProfile({ id: 'incognito', private: true })?.private).toBe(true)
  })

  it('first run creates Default + an in-memory Incognito profile', async () => {
    const { api, datasets } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const profiles = store.getSnapshot().profiles
    expect(profiles.map((p) => p.id)).toEqual(['default', INCOGNITO_PROFILE_ID])
    expect(profiles.find((p) => p.id === INCOGNITO_PROFILE_ID)?.private).toBe(true)
    expect((datasets.get('surfing.profiles') ?? []).map((r) => r.id)).toEqual(['default'])
  })

  it('repairs an existing profile set so Incognito is always available', async () => {
    const { api } = createMockValleyApi({ datasets: { 'surfing.profiles': [{ id: 'default', name: 'Default', createdAt: 0 }] } })
    const store = createStore(api)
    await store.loadConfig()
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(['default', INCOGNITO_PROFILE_ID])
  })

  it('round-trips a renamed Default profile and its chosen icon', async () => {
    const { api } = createMockValleyApi()
    let store = createStore(api)
    await store.loadConfig()
    store.renameProfile('default', 'Canopy')
    store.setProfileIcon('default', 'leaf')
    await store.flushProfiles()

    store = createStore(api)
    await store.loadConfig()
    expect(store.getSnapshot().profiles[0]).toMatchObject({
      id: 'default',
      name: 'Canopy',
      icon: 'leaf'
    })
  })

  it('preserves the Default profile when persisted custom profiles exist', async () => {
    const { api } = createMockValleyApi({
      datasets: {
        'surfing.profiles': [
          { id: 'default', name: 'Default', createdAt: 0 },
          { id: 'p-fungi', name: 'Fungi', createdAt: 1 }
        ]
      }
    })
    const store = createStore(api)
    await store.loadConfig()
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(['default', 'p-fungi', INCOGNITO_PROFILE_ID])
    expect(store.getSnapshot().activeProfileId).toBe('default')
  })
})

describe('web store (favorites)', () => {
  it('toggleFavorite adds then removes, persists, and reflects via isFavorite', async () => {
    const { api, datasets } = createMockValleyApi()
    const store = createStore(api)
    const page = { url: 'https://fav.example', title: 'Favorite', ts: 1 }

    expect(await store.toggleFavorite('default', page)).toBe(true)
    expect(store.isFavorite('default', page.url)).toBe(true)
    expect((datasets.get('surfing.saved_pages') ?? []).filter((r) => r.kind === 'favorite').map((r) => r.url)).toEqual(['https://fav.example'])

    expect(await store.toggleFavorite('default', page)).toBe(false)
    expect(store.isFavorite('default', page.url)).toBe(false)
    expect((datasets.get('surfing.saved_pages') ?? []).filter((r) => r.kind === 'favorite')).toEqual([])
  })

  it('keeps favorites isolated per profile', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const fungi = store.addProfile('Fungi')
    await store.toggleFavorite('default', { url: 'https://a.example', title: 'A', ts: 1 })
    await store.toggleFavorite(fungi, { url: 'https://b.example', title: 'B', ts: 2 })

    expect(store.isFavorite('default', 'https://a.example')).toBe(true)
    expect(store.isFavorite('default', 'https://b.example')).toBe(false)
    expect(store.isFavorite(fungi, 'https://b.example')).toBe(true)
  })
})

describe('web store (reading list)', () => {
  it('addToReadingList / removeFromReadingList persist newest-first', async () => {
    const { api, datasets } = createMockValleyApi()
    const store = createStore(api)
    await store.addToReadingList('default', { url: 'https://one.example', title: 'One', ts: 1 })
    await store.addToReadingList('default', { url: 'https://two.example', title: 'Two', ts: 2 })
    expect((datasets.get('surfing.saved_pages') ?? []).filter((r) => r.kind === 'reading').map((r) => r.url)).toEqual([
      'https://two.example',
      'https://one.example'
    ])

    await store.removeFromReadingList('default', 'https://one.example')
    expect((datasets.get('surfing.saved_pages') ?? []).filter((r) => r.kind === 'reading').map((r) => r.url)).toEqual(['https://two.example'])
  })
})

describe('web store (private profile + active-list snapshot)', () => {
  it('a private (Incognito) profile records no history', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig() // seeds the private Incognito profile
    store.setActiveProfile(INCOGNITO_PROFILE_ID)
    const incog = store.openTab('')
    store.reportUrl(incog, 'https://private.example')
    expect(await store.readHistory(INCOGNITO_PROFILE_ID)).toHaveLength(0)

    // A normal profile still logs.
    store.setActiveProfile('default')
    const normal = store.openTab('')
    store.reportUrl(normal, 'https://public.example')
    expect((await store.readHistory('default')).map((e) => e.url)).toEqual(['https://public.example'])
  })

  it('snapshot favorites/history mirror the active profile and refresh on switch', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    await store.toggleFavorite('default', { url: 'https://d.example', title: 'D', ts: 1 })
    expect(store.getSnapshot().favorites.map((f) => f.url)).toEqual(['https://d.example'])

    const t = store.openTab('')
    store.reportUrl(t, 'https://timeline.example')
    expect(store.getSnapshot().history.map((h) => h.url)).toEqual(['https://timeline.example'])

    // Switching to Incognito swaps in its (empty) lists.
    store.setActiveProfile(INCOGNITO_PROFILE_ID)
    await tick()
    expect(store.getSnapshot().favorites).toEqual([])
    expect(store.getSnapshot().history).toEqual([])

    // Switching back restores the default profile's lists.
    store.setActiveProfile('default')
    await tick()
    expect(store.getSnapshot().favorites.map((f) => f.url)).toEqual(['https://d.example'])
    expect(store.getSnapshot().history.map((h) => h.url)).toEqual(['https://timeline.example'])
  })

  // Settings → Profiles counts every profile, not just the active one, so the
  // rows must read from the per-profile caches rather than the snapshot.
  it('profileStats counts a non-active profile once its lists are hydrated', async () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    await store.loadConfig()
    const fungi = store.addProfile('Fungi')
    const spores = store.addProfile('Spores')
    store.setActiveProfile(spores)

    await store.toggleFavorite(fungi, { url: 'https://a.example', title: 'A', ts: 1 })
    await store.addToReadingList(fungi, { url: 'https://b.example', title: 'B', ts: 2 })

    await store.ensureProfileLoaded(fungi)
    expect(store.getSnapshot().activeProfileId).not.toBe(fungi)
    expect(store.profileStats(fungi)).toEqual({ favorites: 1, reading: 1, history: 0 })
    expect(store.profileStats(INCOGNITO_PROFILE_ID)).toEqual({ favorites: 0, reading: 0, history: 0 })
  })
})

// Electron throws from every `webContents` reader between mounting a <webview>
// and its `dom-ready`. `Page.tsx` publishes its navigation controller from an
// effect that runs inside exactly that window on a freshly opened tab, so an
// unguarded `canGoBack` took the whole plugin view down with it.
describe('web store (guest not yet dom-ready)', () => {
  const notReady = (): never => {
    throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.')
  }

  it('answers the nav controller instead of throwing', () => {
    const { api } = createMockValleyApi()
    const store = createStore(api)
    const id = store.openTab('https://example.com')
    const views = (store as unknown as { views: Map<string, unknown> }).views
    views.set(id, { canGoBack: notReady, canGoForward: notReady, goBack: notReady, goForward: notReady, reload: notReady })

    expect(store.canGoBack(id)).toBe(false)
    expect(store.canGoForward(id)).toBe(false)
    expect(() => store.goBack(id)).not.toThrow()
    expect(() => store.goForward(id)).not.toThrow()
    expect(() => store.reload(id)).not.toThrow()
  })
})

describe('web store (ad-block sync)', () => {
  const adblockCalls = (api: ReturnType<typeof createMockValleyApi>['api']): unknown[] => vi.mocked(api.backend.call).mock.calls.filter(([method]) => method === 'filter.configure').map(([, payload]) => payload)

  it('coalesces a burst of filter-list edits into one engine rebuild', async () => {
    vi.useFakeTimers()
    try {
      const { api, driverCalls } = createMockValleyApi()
      const store = createStore(api)
      driverCalls.length = 0

      store.setProfileAdblockSetting('default', 'adblockRules', 'https://one.example/list.txt')
      store.setProfileAdblockSetting('default', 'adblockRules', 'https://one.example/list.txt\nhttps://two.example/list.txt')
      store.setProfileAdblockSetting('default', 'adblockFrequency', 3)
      expect(adblockCalls(api)).toEqual([])

      vi.advanceTimersByTime(500)
      const pushed = adblockCalls(api)
      expect(pushed).toHaveLength(1)
      expect(pushed[0]).toMatchObject({ profiles: expect.arrayContaining([{
        partition: 'persist:web-default',
        enabled: true,
        rules: 'https://one.example/list.txt\nhttps://two.example/list.txt',
        frequencyDays: 3
      }]) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a pending push when the plugin session is torn down', () => {
    vi.useFakeTimers()
    try {
      const { api, driverCalls } = createMockValleyApi()
      const store = createStore(api)
      driverCalls.length = 0

      store.setProfileAdblockSetting('default', 'adblockEnabled', false)
      expect(adblockCalls(api)).toEqual([])

      store.dispose()
      expect(adblockCalls(api)).toHaveLength(1)
      expect(adblockCalls(api)[0]).toMatchObject({ profiles: expect.arrayContaining([expect.objectContaining({
        partition: 'persist:web-default',
        enabled: false
      })]) })
    } finally {
      vi.useRealTimers()
    }
  })
})
