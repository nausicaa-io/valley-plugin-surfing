import { uiText } from './localization'
import { watchBrowserCosmetics } from './browserCosmetics'
import { browserAutomation } from './browserAutomation'
import type { PluginBrowserGuestEvent } from '@valley/plugin-sdk'
import type {
  BrowserActionResult,
  BrowserCaptureResult,
  BrowserHtmlResult,
  BrowserSnapshotResult,
  BrowserTabsResult,
  BrowserTextResult,
  PlaybackSource,
  PluginPlaybackHandle,
  ValleyPluginApi
} from '@valley/plugin-sdk'
import type { DriverResult } from '@valley/plugin-sdk/types'
import type { DatasetKey, DatasetRecord, DatasetWhere } from '@valley/plugin-sdk'
import {
  canDeleteProfile,
  canHideProfile,
  DEFAULT_PROFILE_ID,
  DEFAULT_SETTINGS,
  INCOGNITO_PROFILE_ID,
  newProfileId,
  normalizeProfile,
  normalizeProfileAdblock,
  normalizeSavedPage,
  normalizeSettings,
  partitionFor,
  reconcileProfiles,
  searchUrl,
  switcherProfiles,
  type HistoryEntry,
  type SavedPage,
  type SearchEngineId,
  type WebProfile,
  type WebSettings
} from './profiles'
import { api as runtimeApi } from './runtime'

export interface WebTabState {
  url: string
  title: string
  profileId: string
  metadata?: WebPageMetadata
}

export interface WebPageMetadata {
  description?: string
  image?: string
  siteName?: string
  type?: string
  author?: string
  icon?: string
  canonical?: string
  language?: string
}

export interface WebSnapshot {
  tabs: Record<string, WebTabState>
  profiles: WebProfile[]
  activeProfileId: string
  settings: WebSettings
  // The active profile's saved-page lists (newest-first), surfaced for the
  // sidebar Panel. Favorites + reading list are user-curated; `history` is the
  // browsing timeline (empty for a private profile). Kept per-profile on disk;
  // the snapshot mirrors only the active profile and refreshes on switch.
  favorites: SavedPage[]
  readingList: SavedPage[]
  history: SavedPage[]
}

interface WebviewEl {
  guestId: string
  url: string
  back: boolean
  forward: boolean
  audible: boolean
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  isCurrentlyAudible(): boolean
}

const STORE_KEY = 'surfing.store'
const PROFILES_DATASET = 'profiles'
const PROFILE_ADBLOCK_DATASET = 'profile_adblock'
const TABS_DATASET = 'tabs'
const VISITS_DATASET = 'visits'
const SAVED_PAGES_DATASET = 'saved_pages'
/** Coalescing window for `setAdblock` pushes (ms) — see {@link WebStore.syncAdblock}. */
const ADBLOCK_SYNC_DELAY = 250
const PAGE_METADATA_SCRIPT = `(() => {
  const content = (...selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector)
      const value = element?.getAttribute('content')?.trim()
      if (value) return value
    }
    return ''
  }
  const absolute = (value) => {
    if (!value) return ''
    try { return new URL(value, document.baseURI).href } catch { return '' }
  }
  return {
    description: content('meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[name="description"]'),
    image: absolute(content('meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]')),
    siteName: content('meta[property="og:site_name"]', 'meta[name="application-name"]'),
    type: content('meta[property="og:type"]'),
    author: content('meta[name="author"]', 'meta[property="article:author"]'),
    icon: absolute(document.querySelector('link[rel~="icon"]')?.getAttribute('href') || ''),
    canonical: absolute(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || ''),
    language: document.documentElement.lang || ''
  }
})()`

function normalizePageMetadata(raw: unknown): WebPageMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const value = raw as Record<string, unknown>
  return Object.fromEntries(
    ['description', 'image', 'siteName', 'type', 'author', 'icon', 'canonical', 'language']
      .map((key) => [key, typeof value[key] === 'string' ? value[key].trim() : ''])
      .filter((entry) => entry[1])
  ) as WebPageMetadata
}

let counter = 0
function genId(): string {
  return `web-${Date.now().toString(36)}-${(counter++).toString(36)}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** Normalize address-bar input: keep explicit schemes, https-prefix a bare
 *  domain, otherwise treat it as a search on the chosen engine. */
export function toUrl(input: string, engine: SearchEngineId = 'google'): string {
  const s = input.trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  if (!/\s/.test(s) && /\.[a-z]{2,}/i.test(s)) return `https://${s}`
  return searchUrl(engine, s)
}

export class WebStore {
  api: ValleyPluginApi
  private listeners = new Set<() => void>()
  private snap: WebSnapshot = {
    tabs: {},
    profiles: reconcileProfiles([]),
    activeProfileId: DEFAULT_PROFILE_ID,
    settings: DEFAULT_SETTINGS,
    favorites: [],
    readingList: [],
    history: []
  }
  private lastHistoryUrl = new Map<string, string>()
  private profileWrites: Promise<void> = Promise.resolve()

  // ── Per-profile saved-page lists (favorites / reading list / timeline) ──────
  // Caches keyed by profileId, hydrated lazily from datasets via loadProfileLists.
  // Each holds the list newest-first; history is mirrored here for the panel.
  private favCache = new Map<string, SavedPage[]>()
  private readingCache = new Map<string, SavedPage[]>()
  private histCache = new Map<string, SavedPage[]>()
  private listLoads = new Map<string, Promise<void>>()
  private historyWriteQueue: Promise<void> = Promise.resolve()
  private lastHistoryTs = new Map<string, number>()
  private adblockTimer: number | null = null

  // ── Open-tab persistence ──────────────────────────────────────────────────
  // The workspace persists each browser tab's `instanceId`, but the per-tab
  // url/title/profile live only in this session store and are wiped on a
  // full app reload (Cmd+R) — a reloaded tab would otherwise reopen the homepage.
  // We mirror `tabs` to the plugin cache dataset so a reload reopens the exact
  // page that was showing. `tabsLoaded` gates persistence so an early
  // mount can't overwrite the saved set before {@link loadConfig} restores it.
  private tabsLoaded = false
  private persistTimer: number | null = null

  // ── Media / footer playback ───────────────────────────────────────────────
  // A guest playing audible media registers a PlaybackSource so the shared
  // footer bar (play/pause + volume) can drive it. Volume is kept per tab so it
  // survives navigation; `active` tracks which guests currently have media.
  private mediaVolume = new Map<string, number>()
  private mediaActive = new Set<string>()
  private mediaPlayback = new Map<string, PluginPlaybackHandle>()

  private views = new Map<string, WebviewEl>()
  private cosmetics = new Map<string, () => void>()
  private browserGuests = new Map<string, string>()
  private hosts = new Set<string>()
  private reconcileTimer: number | null = null
  private offBrowser: () => void

  constructor(api: ValleyPluginApi) {
    this.api = api
    this.offBrowser = api.drivers.browser.onEvent((event) => {
      const id = [...this.browserGuests].find(([, guestId]) => guestId === event.guestId)?.[0]
      if (id) this.guestEvent(id, event)
    })
  }

  private async rows(datasetId: string, where?: DatasetWhere, orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>): Promise<DatasetRecord[]> {
    const dataset = this.api.data.dataset(datasetId)
    const rows: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      const page = await dataset.query({ where, orderBy, limit: 1000, cursor })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor)
    return rows
  }

  private async replaceRows(
    datasetId: string,
    primaryKey: string[],
    records: DatasetRecord[],
    where?: DatasetWhere
  ): Promise<void> {
    const dataset = this.api.data.dataset(datasetId)
    const existing = await this.rows(datasetId, where)
    const operations = [
      ...existing.map((record) => ({
        operation: 'delete' as const,
        key: Object.fromEntries(primaryKey.map((field) => [field, record[field] ?? null])) as DatasetKey
      })),
      ...records.map((values) => ({ operation: 'upsert' as const, values }))
    ]
    for (let index = 0; index < operations.length; index += 500) {
      await dataset.batch(operations.slice(index, index + 500))
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  // Referentially stable between mutations — required by useSyncExternalStore.
  getSnapshot = (): WebSnapshot => this.snap

  private setSnap(next: Partial<WebSnapshot>): void {
    this.snap = { ...this.snap, ...next }
    for (const l of this.listeners) l()
  }

  private patch(id: string, p: Partial<WebTabState>): boolean {
    const cur = this.snap.tabs[id]
    if (!cur) return false
    const next = { ...cur, ...p }
    if (next.url === cur.url && next.title === cur.title && next.profileId === cur.profileId && JSON.stringify(next.metadata) === JSON.stringify(cur.metadata)) return false
    this.setSnap({ tabs: { ...this.snap.tabs, [id]: next } })
    this.persistTabs()
    return true
  }

  /** Mirror the open tabs (url/title/profile per `instanceId`) to disk so a full
   *  app reload reopens the page each tab was showing. Debounced + gated on
   *  {@link tabsLoaded} (never persist before the saved set is restored). */
  private persistTabs(): void {
    if (!this.tabsLoaded) return
    if (this.persistTimer != null) clearTimeout(this.persistTimer)
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null
      const recs = Object.entries(this.snap.tabs)
        .filter(([, tab]) => !this.isPrivate(tab.profileId))
        .map(([id, t]) => ({ id, url: t.url, title: t.title, profileId: t.profileId }))
      void this.replaceRows(TABS_DATASET, ['id'], recs)
    }, 400)
  }

  // ── Config (profiles + settings) ──────────────────────────────────────────
  /** Load persisted settings + profiles (call once on register). */
  async loadConfig(): Promise<void> {
    const raw = this.api.settings.get()
    const settings = normalizeSettings(raw)
    let profiles: WebProfile[] = []
    try {
      const recs = await this.rows(PROFILES_DATASET)
      profiles = recs.map((r) => normalizeProfile(r)).filter((p): p is WebProfile => p != null)
    } catch {
      /* first run */
    }
    profiles = reconcileProfiles(profiles)
    try {
      const adblockRows = await this.rows(PROFILE_ADBLOCK_DATASET)
      const byProfile = new Map(adblockRows.flatMap((row) => typeof row.profileId === 'string' ? [[row.profileId, row] as const] : []))
      profiles = profiles.map((profile) => ({
        ...profile,
        ...normalizeProfileAdblock(byProfile.get(profile.id) ?? {})
      }))
    } catch {
      /* first run */
    }
    const normalProfileId = profiles.find((p) => !p.private)?.id ?? DEFAULT_PROFILE_ID
    const wanted = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : DEFAULT_PROFILE_ID
    const activeProfileId = profiles.some((p) => p.id === wanted) ? wanted : normalProfileId

    // Restore the open tabs persisted before the last reload. Merge under any tab
    // an early Page mount already created: keep a tab the user has actively
    // navigated (non-empty url), otherwise adopt the saved page.
    const restored: Record<string, WebTabState> = {}
    try {
      const recs = await this.rows(TABS_DATASET)
      for (const r of recs) {
        const id = typeof r.id === 'string' ? r.id : ''
        if (!id) continue
        const profileId =
          typeof r.profileId === 'string' && profiles.some((p) => p.id === r.profileId)
            ? r.profileId
            : normalProfileId
        restored[id] = {
          url: typeof r.url === 'string' ? r.url : '',
          title: typeof r.title === 'string' ? r.title : '',
          profileId
        }
      }
    } catch {
      /* first run — nothing saved yet */
    }
    const tabs: Record<string, WebTabState> = { ...this.snap.tabs }
    for (const [id, t] of Object.entries(restored)) {
      const cur = tabs[id]
      if (!cur || !cur.url) tabs[id] = t
    }
    const remounted = new Set<string>()
    for (const [id, tab] of Object.entries(tabs)) {
      if (!profiles.some((p) => p.id === tab.profileId)) {
        tabs[id] = { ...tab, profileId: normalProfileId }
        remounted.add(id)
      }
    }

    await this.loadProfileLists(activeProfileId)
    this.setSnap({
      settings,
      profiles,
      activeProfileId,
      tabs,
      favorites: this.favCache.get(activeProfileId) ?? [],
      readingList: this.readingCache.get(activeProfileId) ?? [],
      history: this.histCache.get(activeProfileId) ?? []
    })
    await this.persistProfiles()
    if (activeProfileId !== wanted) void this.api.settings.set('activeProfileId', activeProfileId)
    this.tabsLoaded = true
    // A guest created before the restore landed (empty url → homepage) is now
    // re-driven to its saved page; refresh each restored Notes tab label too.
    for (const id of Object.keys(tabs)) {
      if (remounted.has(id)) this.disposeView(id)
      this.drive(id)
      this.updateWorkspaceTabTitle(id)
    }
    if (remounted.size > 0) this.persistTabs()
    this.syncAdblock(true)
  }

  /** Push every profile's ad-block settings to the main-process engines. Runs on
   *  load and whenever one profile's blocker configuration changes.
   *  Coalesced: main rebuilds the whole Ghostery engine per call, so flipping a
   *  handful of filter-list toggles must reach it as one push, not one each. */
  private syncAdblock(immediate = false): void {
    if (this.adblockTimer != null) window.clearTimeout(this.adblockTimer)
    if (immediate) {
      this.adblockTimer = null
      this.pushAdblock()
      return
    }
    this.adblockTimer = window.setTimeout(() => {
      this.adblockTimer = null
      this.pushAdblock()
    }, ADBLOCK_SYNC_DELAY)
  }

  private pushAdblock(): void {
    void this.api.backend.call('filter.configure', {
      profiles: this.snap.profiles.map((profile) => ({
        partition: partitionFor(profile.id),
        enabled: profile.adblockEnabled,
        rules: profile.adblockRules,
        frequencyDays: profile.adblockFrequency
      }))
    }).catch((error) => console.error(error))
  }

  get settings(): WebSettings {
    return this.snap.settings
  }

  setSetting<K extends keyof WebSettings>(key: K, value: WebSettings[K]): void {
    this.setSnap({ settings: { ...this.snap.settings, [key]: value } })
    void this.api.settings.set(key, value)
  }

  // ── Profiles ──────────────────────────────────────────────────────────────
  private persistProfiles(): Promise<void> {
    const profiles = this.snap.profiles
      .filter((profile) => !profile.private)
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        createdAt: profile.createdAt,
        icon: profile.icon ?? null,
        hidden: profile.hidden ?? null
      })) as DatasetRecord[]
    const adblock = this.snap.profiles.map((profile) => ({
      profileId: profile.id,
      adblockEnabled: profile.adblockEnabled,
      adblockRules: profile.adblockRules,
      adblockFrequency: profile.adblockFrequency
    })) as DatasetRecord[]
    const write = this.profileWrites.catch(() => {}).then(() => Promise.all([
      this.replaceRows(PROFILES_DATASET, ['id'], profiles),
      this.replaceRows(PROFILE_ADBLOCK_DATASET, ['profileId'], adblock)
    ])).then(() => undefined)
    this.profileWrites = write
    return write
  }

  flushProfiles(): Promise<void> { return this.profileWrites }

  addProfile(name: string): string {
    const id = newProfileId()
    const profile: WebProfile = {
      id,
      name: name.trim() || 'Profile',
      createdAt: Date.now(),
      ...normalizeProfileAdblock({})
    }
    const profiles = reconcileProfiles([...this.snap.profiles, profile])
    this.setSnap({ profiles })
    void this.persistProfiles()
    this.syncAdblock()
    return id
  }

  setProfileAdblockSetting<K extends 'adblockEnabled' | 'adblockRules' | 'adblockFrequency'>(
    id: string,
    key: K,
    value: WebProfile[K]
  ): void {
    if (!this.snap.profiles.some((profile) => profile.id === id)) return
    this.setSnap({
      profiles: this.snap.profiles.map((profile) => profile.id === id ? { ...profile, [key]: value } : profile)
    })
    void this.persistProfiles()
    this.syncAdblock()
  }

  renameProfile(id: string, name: string): void {
    if (id === INCOGNITO_PROFILE_ID) return
    this.setSnap({ profiles: this.snap.profiles.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)) })
    void this.persistProfiles()
  }

  /** Pick the mark shown in the sidebar switcher; an empty id restores the letter. */
  setProfileIcon(id: string, icon: string): void {
    if (id === INCOGNITO_PROFILE_ID) return
    this.setSnap({
      profiles: this.snap.profiles.map((p) => {
        if (p.id !== id) return p
        const next: WebProfile = { ...p }
        if (icon) next.icon = icon
        else delete next.icon
        return next
      })
    })
    void this.persistProfiles()
  }

  /**
   * Show/hide a profile in the sidebar switcher. The profile itself (cookies,
   * logins, lists) is untouched — hiding the *active* one just moves the session
   * to the first profile still on show, and the last visible one cannot be hidden.
   */
  setProfileHidden(id: string, hidden: boolean): void {
    if (id === INCOGNITO_PROFILE_ID) return
    if (hidden && !canHideProfile(this.snap.profiles, id)) return
    const profiles = this.snap.profiles.map((p) => {
      if (p.id !== id) return p
      const next: WebProfile = { ...p }
      if (hidden) next.hidden = true
      else delete next.hidden
      return next
    })
    const shown = switcherProfiles(profiles)
    const wasActive = this.snap.activeProfileId === id
    const activeProfileId = wasActive && hidden ? (shown[0]?.id ?? this.snap.activeProfileId) : this.snap.activeProfileId
    const switched = activeProfileId !== this.snap.activeProfileId
    this.setSnap({ profiles, activeProfileId })
    void this.persistProfiles()
    if (switched) {
      void this.api.settings.set('activeProfileId', activeProfileId)
      void this.refreshActiveLists()
    }
  }

  async deleteProfile(id: string): Promise<void> {
    if (!canDeleteProfile(this.snap.profiles, id)) return
    const profiles = reconcileProfiles(this.snap.profiles.filter((p) => p.id !== id))
    const replacementId = switcherProfiles(profiles)[0]?.id ?? profiles.find((p) => !p.private)?.id ?? DEFAULT_PROFILE_ID
    const wasActive = this.snap.activeProfileId === id
    const activeProfileId = wasActive ? replacementId : this.snap.activeProfileId
    const tabs = this.remapTabProfile(this.snap.tabs, id, replacementId)
    this.setSnap({ profiles, activeProfileId, tabs })
    if (wasActive) void this.api.settings.set('activeProfileId', activeProfileId)
    const persisted = this.persistProfiles()
    this.persistTabs()
    this.remountProfileViews(id)
    this.syncAdblock()
    const clearedBrowserData = this.clearBrowserData(id)
    // Drop the deleted profile's per-profile lists (history/favorites/reading).
    const clearedHistory = this.clearHistory(id)
    this.favCache.delete(id)
    this.readingCache.delete(id)
    this.histCache.delete(id)
    this.listLoads.delete(id)
    await Promise.all([
      persisted,
      clearedBrowserData,
      clearedHistory,
      this.replaceRows(SAVED_PAGES_DATASET, ['profileId', 'kind', 'url'], [], { profileId: id })
    ])
    if (wasActive) await this.refreshActiveLists()
  }

  private remapTabProfile(
    tabs: Record<string, WebTabState>,
    fromProfileId: string,
    toProfileId: string
  ): Record<string, WebTabState> {
    return Object.fromEntries(
      Object.entries(tabs).map(([id, tab]) => [
        id,
        tab.profileId === fromProfileId ? { ...tab, profileId: toProfileId } : tab
      ])
    )
  }

  private remountProfileViews(profileId: string): void {
    for (const id of this.views.keys()) if (this.snap.tabs[id]?.profileId === profileId) this.disposeView(id)
  }

  setActiveProfile(id: string): void {
    if (!this.snap.profiles.some((p) => p.id === id)) return
    this.setSnap({ activeProfileId: id })
    void this.api.settings.set('activeProfileId', id)
    void this.refreshActiveLists()
  }

  private profileById(id: string): WebProfile | undefined {
    return this.snap.profiles.find((p) => p.id === id)
  }

  /** A private profile (Incognito) never records browsing history. */
  private isPrivate(id: string): boolean {
    return this.profileById(id)?.private === true
  }

  // ── Saved-page lists (favorites / reading list / timeline) ──────────────────
  /** Hydrate a profile's three lists from disk into the caches (once). Each cache
   *  holds the list newest-first. Concurrent callers share a single in-flight load. */
  loadProfileLists(profileId: string): Promise<void> {
    let p = this.listLoads.get(profileId)
    if (!p) {
      p = this.hydrateLists(profileId)
      this.listLoads.set(profileId, p)
    }
    return p
  }

  private async hydrateLists(profileId: string): Promise<void> {
    const [fav, reading, hist] = await Promise.all([
      this.readSavedPages(profileId, 'favorite'),
      this.readSavedPages(profileId, 'reading'),
      this.readVisits(profileId)
    ])
    this.favCache.set(profileId, fav)
    this.readingCache.set(profileId, reading)
    this.histCache.set(profileId, hist)
    if (hist[0]?.ts != null) this.lastHistoryTs.set(profileId, hist[0].ts)
  }

  /** Read one saved-page kind in its persisted order. */
  private async readSavedPages(profileId: string, kind: 'favorite' | 'reading'): Promise<SavedPage[]> {
    try {
      const recs = await this.rows(SAVED_PAGES_DATASET, { profileId, kind }, [{ field: 'position', direction: 'asc' }])
      const list = recs.map((r) => normalizeSavedPage(r)).filter((p): p is SavedPage => p != null)
      return list
    } catch {
      return []
    }
  }

  private async readVisits(profileId: string): Promise<SavedPage[]> {
    try {
      const recs = await this.rows(VISITS_DATASET, { profileId }, [{ field: 'ts', direction: 'desc' }])
      return recs.map((record) => normalizeSavedPage(record)).filter((page): page is SavedPage => page != null)
    } catch {
      return []
    }
  }

  private persistSavedPages(profileId: string, kind: 'favorite' | 'reading', pages: SavedPage[]): Promise<void> {
    if (this.isPrivate(profileId)) return Promise.resolve()
    const records = pages.map((page, position) => ({
      profileId,
      kind,
      url: page.url,
      title: page.title,
      ts: page.ts,
      position
    })) as DatasetRecord[]
    return this.replaceRows(SAVED_PAGES_DATASET, ['profileId', 'kind', 'url'], records, { profileId, kind })
  }

  /** Ensure a profile's lists are loaded before a mutation (public — the page
   *  toolbar star acts on the viewed tab's profile, which may not be active). */
  ensureProfileLoaded(profileId: string): Promise<void> {
    return this.loadProfileLists(profileId)
  }

  /** How much a profile holds, for the Settings → Profiles rows. Reads the
   *  caches only — call {@link ensureProfileLoaded} first for a profile that has
   *  never been active, or the counts read zero. */
  profileStats(profileId: string): { favorites: number; reading: number; history: number } {
    return {
      favorites: this.favCache.get(profileId)?.length ?? 0,
      reading: this.readingCache.get(profileId)?.length ?? 0,
      history: this.histCache.get(profileId)?.length ?? 0
    }
  }

  /** Re-mirror the active profile's caches into the snapshot (after a switch). */
  private async refreshActiveLists(): Promise<void> {
    const id = this.snap.activeProfileId
    await this.loadProfileLists(id)
    if (this.snap.activeProfileId !== id) return // switched again mid-load
    this.setSnap({
      favorites: this.favCache.get(id) ?? [],
      readingList: this.readingCache.get(id) ?? [],
      history: this.histCache.get(id) ?? []
    })
  }

  /** Push the active profile's favorites/readingList/history arrays into the
   *  snapshot from the caches (new references → the Panel re-renders). */
  private syncActiveLists(profileId: string): void {
    if (profileId !== this.snap.activeProfileId) return
    this.setSnap({
      favorites: [...(this.favCache.get(profileId) ?? [])],
      readingList: [...(this.readingCache.get(profileId) ?? [])],
      history: [...(this.histCache.get(profileId) ?? [])]
    })
  }

  isFavorite(profileId: string, url: string): boolean {
    return (this.favCache.get(profileId) ?? []).some((p) => p.url === url)
  }

  /** Toggle a page in a profile's favorites (dedup by url). Returns the new state.
   *  A private profile (Incognito) keeps the toggle for the current session only —
   *  it never reaches disk, so nothing survives once the session ends. */
  async toggleFavorite(profileId: string, page: SavedPage): Promise<boolean> {
    if (!page.url) return false
    await this.loadProfileLists(profileId)
    const cur = this.favCache.get(profileId) ?? []
    const exists = cur.some((p) => p.url === page.url)
    const next = exists ? cur.filter((p) => p.url !== page.url) : [page, ...cur]
    this.favCache.set(profileId, next)
    await this.persistSavedPages(profileId, 'favorite', next)
    this.syncActiveLists(profileId)
    return !exists
  }

  async removeFavorite(profileId: string, url: string): Promise<void> {
    await this.loadProfileLists(profileId)
    const next = (this.favCache.get(profileId) ?? []).filter((p) => p.url !== url)
    this.favCache.set(profileId, next)
    await this.persistSavedPages(profileId, 'favorite', next)
    this.syncActiveLists(profileId)
  }

  /** Add a page to a profile's reading list (dedup by url, newest-first). Private
   *  profiles keep the addition for the current session only (never persisted). */
  async addToReadingList(profileId: string, page: SavedPage): Promise<void> {
    if (!page.url) return
    await this.loadProfileLists(profileId)
    const cur = this.readingCache.get(profileId) ?? []
    const next = [page, ...cur.filter((p) => p.url !== page.url)]
    this.readingCache.set(profileId, next)
    await this.persistSavedPages(profileId, 'reading', next)
    this.syncActiveLists(profileId)
  }

  async removeFromReadingList(profileId: string, url: string): Promise<void> {
    await this.loadProfileLists(profileId)
    const next = (this.readingCache.get(profileId) ?? []).filter((p) => p.url !== url)
    this.readingCache.set(profileId, next)
    await this.persistSavedPages(profileId, 'reading', next)
    this.syncActiveLists(profileId)
  }

  /** Open a saved/historical url as its own browser tab (used by the sidebar lists). */
  openUrl(url: string, title = ''): string {
    const id = this.openTab(url)
    try {
      this.api.workspace.openMainTab({ instanceId: id, title: title || url || 'New tab', newTab: true })
    } catch {
      /* host not ready */
    }
    return id
  }

  // ── History (per profile) ─────────────────────────────────────────────────
  private appendHistory(profileId: string, url: string, title: string): void {
    if (this.isPrivate(profileId)) return // a private profile keeps no timeline
    if (!/^https?:/i.test(url)) return
    if (this.lastHistoryUrl.get(profileId) === url) return
    this.lastHistoryUrl.set(profileId, url)
    const cachedTs = this.histCache.get(profileId)?.[0]?.ts ?? 0
    const ts = Math.max(Date.now(), cachedTs + 1, (this.lastHistoryTs.get(profileId) ?? 0) + 1)
    this.lastHistoryTs.set(profileId, ts)
    const row = { id: `${profileId}:${ts}:${counter++}`, profileId, url, title, ts }
    this.historyWriteQueue = this.historyWriteQueue
      .then(async () => { await this.api.data.dataset(VISITS_DATASET).insert(row) })
      .catch(() => {})
    if (this.histCache.has(profileId)) {
      this.histCache.set(profileId, [{ url, title, ts }, ...(this.histCache.get(profileId) ?? [])])
      this.syncActiveLists(profileId)
    }
  }

  async readHistory(profileId: string): Promise<HistoryEntry[]> {
    await this.historyWriteQueue
    return this.readVisits(profileId)
  }

  async clearHistory(profileId: string): Promise<void> {
    await this.historyWriteQueue
    this.lastHistoryUrl.delete(profileId)
    this.lastHistoryTs.delete(profileId)
    this.histCache.set(profileId, [])
    this.syncActiveLists(profileId)
    try {
      const rows = await this.rows(VISITS_DATASET, { profileId })
      const dataset = this.api.data.dataset(VISITS_DATASET)
      for (let index = 0; index < rows.length; index += 500) {
        await dataset.batch(rows.slice(index, index + 500).map((row) => ({ operation: 'delete', key: { id: typeof row.id === 'string' ? row.id : '' } })))
      }
    } catch {
      /* nothing to clear */
    }
  }

  /** Clear cookies/cache/storage for a profile's isolated partition (main process
   *  owns the Electron session — the renderer is not the trust boundary). */
  async clearBrowserData(profileId: string): Promise<void> {
    const partition = partitionFor(profileId)
    const bound = await this.api.drivers.browser.bindPartition(partition)
    if (!bound.ok) throw new Error(bound.error || uiText('surfing.error.storage'))
    const result = await this.api.drivers.browser.clearData(partition)
    if (!result.ok) throw new Error(result.error || uiText('surfing.error.clear'))
  }

  // ── Tab state (React-facing) ──────────────────────────────────────────────
  /** Open a new browser tab (in the active profile unless one is named — a private
   *  tab runs in the Incognito session without moving the sidebar off the user's
   *  profile); returns its `instanceId`. */
  openTab(input = '', profileId = this.snap.activeProfileId): string {
    const id = genId()
    const url = input.trim() ? toUrl(input, this.snap.settings.searchEngine) : ''
    this.setSnap({ tabs: { ...this.snap.tabs, [id]: { url, title: '', profileId } } })
    this.persistTabs()
    return id
  }

  /** Ensure a record exists (a reload restored the Notes tab but emptied the store). */
  ensureTab(id: string): void {
    if (!this.snap.tabs[id]) {
      this.setSnap({ tabs: { ...this.snap.tabs, [id]: { url: '', title: '', profileId: this.snap.activeProfileId } } })
    }
  }

  getTab(id: string): WebTabState | undefined {
    return this.snap.tabs[id]
  }

  restoreTab(id: string, tab: WebTabState): void {
    if (!this.snap.profiles.some((profile) => profile.id === tab.profileId)) throw new Error(uiText('surfing.error.profile'))
    const previous = this.snap.tabs[id]
    if (previous?.profileId !== tab.profileId) this.disposeView(id)
    this.setSnap({ tabs: { ...this.snap.tabs, [id]: { ...tab } } })
    this.persistTabs()
    this.drive(id)
    this.updateWorkspaceTabTitle(id)
  }

  private browserGuest<T extends DriverResult>(
    instanceId: string,
    run: (guestId: string) => Promise<T>
  ): Promise<T> {
    const guestId = this.browserGuests.get(instanceId)
    if (!guestId) {
      return Promise.resolve({ ok: false, error: uiText('surfing.error.liveTab', { value: instanceId }) } as T)
    }
    return run(guestId)
  }

  async listBrowserTabs(): Promise<BrowserTabsResult> {
    const result = await this.api.drivers.browser.list()
    if (!result.ok) return { ok: false, error: result.error }
    const live = new Set((result.data?.guests ?? []).map((guest) => guest.guestId))
    for (const [instanceId, guestId] of this.browserGuests) {
      if (!live.has(guestId)) this.browserGuests.delete(instanceId)
    }
    const tabs = [...this.browserGuests.keys()].flatMap((instanceId) => {
      const tab = this.snap.tabs[instanceId]
      return tab ? [{ instanceId, url: tab.url, title: tab.title }] : []
    })
    return { ok: true, data: { tabs } }
  }

  browserSnapshot(instanceId: string): Promise<BrowserSnapshotResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).snapshot(guestId))
  }

  browserReadText(instanceId: string, maxChars?: number): Promise<BrowserTextResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).readText(guestId, maxChars))
  }

  browserReadHtml(instanceId: string): Promise<BrowserHtmlResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).readHtml(guestId))
  }

  browserScreenshot(instanceId: string): Promise<BrowserCaptureResult> {
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.screenshot(guestId))
  }

  browserClick(instanceId: string, ref: number): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).click(guestId, ref))
  }

  browserType(instanceId: string, ref: number, text: string, submit?: boolean): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).type(guestId, ref, text, submit))
  }

  browserSelect(instanceId: string, ref: number, value: string): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).select(guestId, ref, value))
  }

  browserScroll(instanceId: string, dx: number, dy: number): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => browserAutomation(this.api).scroll(guestId, dx, dy))
  }

  browserPressKey(instanceId: string, key: string): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.pressKey(guestId, key))
  }

  browserNavigate(instanceId: string, url: string): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.navigate(guestId, url))
  }

  browserBack(instanceId: string): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.back(guestId))
  }

  browserForward(instanceId: string): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.forward(guestId))
  }

  browserReload(instanceId: string): Promise<BrowserActionResult> {
    return this.browserGuest(instanceId, (guestId) => this.api.drivers.browser.reload(guestId))
  }

  /** Address-bar / panel navigation (normalizes input + drives the guest). */
  navigate(id: string, input: string): void {
    const url = toUrl(input, this.snap.settings.searchEngine)
    if (this.patch(id, { url, metadata: undefined })) {
      this.drive(id)
      this.updateWorkspaceTabTitle(id)
    }
  }

  /** The guest navigated itself — record the real URL + log history (no re-drive). */
  reportUrl(id: string, url: string): void {
    const changed = this.snap.tabs[id]?.url !== url
    if (this.patch(id, { url, ...(changed ? { metadata: undefined } : {}) })) {
      const tab = this.snap.tabs[id]
      if (tab) this.appendHistory(tab.profileId, url, tab.title)
      this.updateWorkspaceTabTitle(id)
    }
  }

  setTitle(id: string, title: string): void {
    if (this.patch(id, { title })) this.updateWorkspaceTabTitle(id)
  }

  private async readPageMetadata(id: string, el: WebviewEl): Promise<void> {
    const url = this.snap.tabs[id]?.url
    if (!url) return
    try {
      const metadata = normalizePageMetadata(await el.executeJavaScript(PAGE_METADATA_SCRIPT, false))
      if (this.views.get(id) === el && this.snap.tabs[id]?.url === url) this.patch(id, { metadata })
    } catch {
      /* Cross-origin pages may refuse inspection while navigating. */
    }
  }

  closeTab(id: string): void {
    if (this.snap.tabs[id]) {
      const rest: Record<string, WebTabState> = {}
      for (const [k, v] of Object.entries(this.snap.tabs)) if (k !== id) rest[k] = v
      this.setSnap({ tabs: rest })
      this.persistTabs()
    }
    this.disposeView(id)
  }

  // ── Guest controls (from the page toolbar) ────────────────────────────────
  /**
   * Every one of these reaches into the guest's `webContents`, and Electron
   * *throws* ("The WebView must be attached to the DOM and the dom-ready event
   * emitted before this method can be called") for the whole window between
   * mounting a `<webview>` and its `dom-ready`. `Page.tsx` publishes its
   * navigation controller from an effect that runs inside exactly that window on
   * a freshly opened tab, so an unguarded `canGoBack` crashed the view outright.
   */
  private guestCall<T>(id: string, run: (view: WebviewEl) => T, fallback: T): T {
    const view = this.views.get(id)
    if (!view) return fallback
    try {
      return run(view)
    } catch {
      return fallback /* guest not attached / not dom-ready yet */
    }
  }
  goBack(id: string): void {
    this.guestCall(id, (v) => v.goBack(), undefined)
  }
  goForward(id: string): void {
    this.guestCall(id, (v) => v.goForward(), undefined)
  }
  canGoBack(id: string): boolean {
    return this.guestCall(id, (v) => v.canGoBack(), false)
  }
  canGoForward(id: string): boolean {
    return this.guestCall(id, (v) => v.canGoForward(), false)
  }
  reload(id: string): void {
    this.guestCall(id, (v) => v.reload(), undefined)
  }

  /** Read the current text selection inside a guest's top frame (''=none/failure).
   *  Used to seed a web SideNote from the highlighted text on the page. */
  async getSelectionText(id: string): Promise<string> {
    const v = this.views.get(id)
    if (!v) return ''
    try {
      const text = await v.executeJavaScript('String(window.getSelection?.() ?? "")', false)
      return typeof text === 'string' ? text.trim() : ''
    } catch {
      return ''
    }
  }

  // ── Footer media playback ─────────────────────────────────────────────────
  /** Run JS inside a guest's top frame, swallowing failures (guest not ready,
   *  cross-origin top frame, navigation in flight). */
  private guestJs(id: string, code: string): void {
    const v = this.views.get(id)
    if (!v) return
    try {
      void v.executeJavaScript(code, false).catch(() => undefined)
    } catch {
      /* guest detached */
    }
  }

  /** Toggle every `<video>`/`<audio>` in the guest's top frame (play↔pause). */
  private toggleGuestMedia(id: string): void {
    this.guestJs(
      id,
      `(()=>{const m=[...document.querySelectorAll('video,audio')];const p=m.some(e=>!e.paused);m.forEach(e=>{p?e.pause():e.play()})})()`
    )
  }

  /** Pause every media element (used when another playback source takes over). */
  private pauseGuestMedia(id: string): void {
    this.guestJs(id, `document.querySelectorAll('video,audio').forEach(e=>e.pause())`)
  }

  /** Set guest media volume (0..1); 0 also mutes. Refreshes the footer slider. */
  private setGuestVolume(id: string, vol: number): void {
    const v = Math.max(0, Math.min(1, vol))
    this.mediaVolume.set(id, v)
    this.guestJs(id, `document.querySelectorAll('video,audio').forEach(e=>{e.volume=${v};e.muted=${v === 0}})`)
    if (this.mediaActive.has(id)) {
      try {
        this.mediaPlayback.get(id)?.update(this.buildMediaSource(id, true))
      } catch {
        /* host not ready */
      }
    }
  }

  private buildMediaSource(id: string, isPlaying: boolean): PlaybackSource {
    const tab = this.snap.tabs[id]
    const site = tab ? hostOf(tab.url) : ''
    return {
      id: `web:${id}`,
      title: tab?.title || site || 'Web audio',
      artist: site || undefined,
      isPlaying,
      canSkip: false,
      volume: this.mediaVolume.get(id) ?? 1,
      setVolume: (value) => this.setGuestVolume(id, value),
      toggle: () => this.toggleGuestMedia(id),
      pause: () => this.pauseGuestMedia(id)
    }
  }

  /** Guest media started. Claim the footer only once the page is actually
   *  audible (skips muted autoplay ads, which would otherwise pause music). */
  private onGuestMediaPlay(id: string, attempt = 0): void {
    if (!this.views.get(id)) return
    let audible = false
    try {
      audible = this.views.get(id)?.isCurrentlyAudible() ?? false
    } catch {
      audible = true // method unavailable → assume audible
    }
    if (!audible) {
      // Audibility can lag the play event; recheck a few times, then give up.
      if (attempt < 3) window.setTimeout(() => this.onGuestMediaPlay(id, attempt + 1), 500)
      return
    }
    const stored = this.mediaVolume.get(id)
    if (stored != null && stored !== 1) this.setGuestVolume(id, stored)
    this.mediaActive.add(id)
    try {
      const source = this.buildMediaSource(id, true)
      let handle = this.mediaPlayback.get(id)
      if (!handle) {
        handle = this.api.playback.register(source)
        this.mediaPlayback.set(id, handle)
      }
      handle.claim(source)
    } catch {
      /* host not ready */
    }
  }

  private onGuestMediaPause(id: string): void {
    if (!this.mediaActive.has(id)) return
    try {
      this.mediaPlayback.get(id)?.update(this.buildMediaSource(id, false))
    } catch {
      /* host not ready */
    }
  }

  /** Drop a tab's footer source (on close/dispose) so the bar doesn't strand. */
  private clearMedia(id: string): void {
    this.mediaActive.delete(id)
    this.mediaPlayback.get(id)?.dispose()
    this.mediaPlayback.delete(id)
    this.mediaVolume.delete(id)
  }

  private drive(id: string): void {
    const v = this.views.get(id)
    const url = this.snap.tabs[id]?.url
    if (!v || !url) return
    try {
      if (v.getURL() !== url) void v.loadURL(url)
    } catch {
      /* guest not ready */
    }
  }

  private updateWorkspaceTabTitle(id: string): void {
    const t = this.snap.tabs[id]
    if (!t) return
    const label = t.title || hostOf(t.url) || 'New tab'
    try {
      this.api.workspace.setMainTabTitle(label, id)
    } catch {
      /* host not ready */
    }
  }

  startOverlay(): void {
    if (this.reconcileTimer == null) this.reconcileTimer = window.setInterval(() => this.reconcile(), 1500)
  }

  mountTab(id: string): () => void {
    this.ensureTab(id)
    this.hosts.add(id)
    return () => { this.hosts.delete(id); this.reconcile() }
  }

  readyGuest(id: string, event: PluginBrowserGuestEvent): void {
    if (this.browserGuests.get(id) !== event.guestId) this.guestEvent(id, event)
  }

  guestEvent(id: string, event: PluginBrowserGuestEvent): void {
    if (!this.snap.tabs[id]) return
    if (event.type === 'ready' && event.guestId) {
      this.browserGuests.set(id, event.guestId)
      const guestId = event.guestId
      const driver = this.api.drivers.browser
      const value: WebviewEl = {
        guestId, url: event.url ?? '', back: !!event.canGoBack, forward: !!event.canGoForward, audible: !!event.audible,
        loadURL: async (url) => { const result = await driver.navigate(guestId, url); if (!result.ok) throw new Error(result.error) },
        getURL: () => value.url,
        reload: () => { void driver.reload(guestId) },
        canGoBack: () => value.back, canGoForward: () => value.forward,
        goBack: () => { void driver.back(guestId) }, goForward: () => { void driver.forward(guestId) },
        executeJavaScript: async (script, userGesture) => { const result = await driver.execute(guestId, script, userGesture); if (!result.ok) throw new Error(result.error); return result.data },
        isCurrentlyAudible: () => value.audible
      }
      this.views.set(id, value)
    }
    const view = this.views.get(id)
    if (!view) return
    if (event.url) { view.url = event.url; this.reportUrl(id, event.url) }
    if (event.title) this.setTitle(id, event.title)
    if (event.canGoBack !== undefined) view.back = event.canGoBack
    if (event.canGoForward !== undefined) view.forward = event.canGoForward
    if (event.audible !== undefined) view.audible = event.audible
    if (event.type === 'ready') { this.cosmetics.get(id)?.(); this.cosmetics.set(id, watchBrowserCosmetics(this.api, view.guestId, partitionFor(this.snap.tabs[id].profileId))) }
    if (event.type === 'load' || event.type === 'ready') void this.readPageMetadata(id, view)
    if (event.type === 'media') { if (event.playing) this.onGuestMediaPlay(id); else this.onGuestMediaPause(id) }
    if (event.type === 'command') { if (event.command === 'browser-backward') this.goBack(id); if (event.command === 'browser-forward') this.goForward(id) }
    this.setSnap({})
  }

  private disposeView(id: string): void {
    this.cosmetics.get(id)?.()
    this.cosmetics.delete(id)
    this.clearMedia(id)
    const guestId = this.browserGuests.get(id)
    this.browserGuests.delete(id)
    this.views.delete(id)
    if (guestId) void this.api.drivers.browser.close(guestId)
  }

  private reconcile(): void {
    const open = new Set(this.api.workspace.getOpenMainTabs())
    for (const id of this.views.keys()) if (!open.has(id) && !this.hosts.has(id)) this.closeTab(id)
  }

  dispose(): void {
    if (this.persistTimer != null) clearTimeout(this.persistTimer)
    this.persistTimer = null
    // A pending ad-block push belongs to this session's driver handle — let it
    // land now rather than firing after the plugin has been torn down.
    if (this.adblockTimer != null) {
      window.clearTimeout(this.adblockTimer)
      this.adblockTimer = null
      this.pushAdblock()
    }
    this.offBrowser()
    if (this.reconcileTimer != null) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
    for (const id of this.views.keys()) this.disposeView(id)
    this.hosts.clear()
    this.listeners.clear()
  }
}

export function createStore(api: ValleyPluginApi): WebStore {
  const holder = api.runtime.getOrCreate<{ current: WebStore | null }>(STORE_KEY, () => ({ current: null }))
  holder.current?.dispose()
  const store = new WebStore(api)
  holder.current = store
  return store
}

export function getStore(): WebStore | null {
  return runtimeApi.runtime.getOrCreate<{ current: WebStore | null }>(STORE_KEY, () => ({ current: null })).current
}

export function disposeStore(api: ValleyPluginApi, store: WebStore): void {
  const holder = api.runtime.getOrCreate<{ current: WebStore | null }>(STORE_KEY, () => ({ current: null }))
  if (holder.current !== store) return
  store.dispose()
  holder.current = null
}
