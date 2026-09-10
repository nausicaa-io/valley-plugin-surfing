import { uiText } from './localization'
import type { BrowserAutomationService, BrowserActionResult, ValleyPluginApi } from '@valley/plugin-sdk'
import type { WebStore } from './store'
import { Readability } from '@mozilla/readability'
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })

interface ClipInput {
  instanceId: string
  collision: 'keep-both' | 'overwrite' | 'cancel'
}

type ClipResult = { cancelled: true } | { relPath: string; url: string; title: string }

function safeClipName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled clipping'
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

const unavailableTab = (instanceId: string): BrowserActionResult => ({
  ok: false,
  error: uiText('surfing.error.liveTab', { value: instanceId })
})

export function createBrowserAutomationService(
  api: ValleyPluginApi,
  store: WebStore
): BrowserAutomationService {
  return {
    list: () => store.listBrowserTabs(),
    open: async (url) => {
      const instanceId = store.openTab(url)
      api.workspace.openMainTab({ instanceId, title: url.trim() || 'New tab' })
      const tab = store.getTab(instanceId)
      return { ok: true, data: { instanceId, url: tab?.url ?? '', title: tab?.title } }
    },
    switch: async (instanceId) => {
      if (!store.getTab(instanceId)) return unavailableTab(instanceId)
      api.workspace.openMainTab({ instanceId })
      return { ok: true, data: { info: `Revealed tab ${instanceId}.` } }
    },
    close: async (instanceId) => {
      if (!store.getTab(instanceId)) return unavailableTab(instanceId)
      api.workspace.closeMainTab(instanceId)
      store.closeTab(instanceId)
      return { ok: true, data: { info: `Closed tab ${instanceId}.` } }
    },
    snapshot: (instanceId) => store.browserSnapshot(instanceId),
    readText: (instanceId, maxChars) => store.browserReadText(instanceId, maxChars),
    readHtml: (instanceId) => store.browserReadHtml(instanceId),
    screenshot: (instanceId) => store.browserScreenshot(instanceId),
    navigate: (instanceId, url) => store.browserNavigate(instanceId, url),
    back: (instanceId) => store.browserBack(instanceId),
    forward: (instanceId) => store.browserForward(instanceId),
    reload: (instanceId) => store.browserReload(instanceId),
    click: (instanceId, ref) => store.browserClick(instanceId, ref),
    type: (instanceId, ref, text, submit) => store.browserType(instanceId, ref, text, submit),
    select: (instanceId, ref, value) => store.browserSelect(instanceId, ref, value),
    scroll: (instanceId, dx, dy) => store.browserScroll(instanceId, dx, dy),
    pressKey: (instanceId, key) => store.browserPressKey(instanceId, key)
  }
}

async function clippingPath(
  api: ValleyPluginApi,
  title: string,
  collision: 'keep-both' | 'overwrite' | 'cancel'
): Promise<{ relPath: string; previous: string | null } | null> {
  const stem = safeClipName(title)
  const initial = `Clippings/${stem}.md`
  const exists = await api.vault.stat(initial)
  if (!exists) return { relPath: initial, previous: null }
  if (collision === 'cancel') return null
  if (collision === 'overwrite') return { relPath: initial, previous: await api.vault.readFile(initial) }
  for (let index = 2; index < 10_000; index++) {
    const relPath = `Clippings/${stem} (${index}).md`
    if (!(await api.vault.stat(relPath))) return { relPath, previous: null }
  }
  throw new Error(uiText('surfing.error.clipName'))
}

/**
 * Register the user-facing `web:*` command-bus commands for ⌘P and CLI. Plugin
 * automation uses the separately registered `browser.automation` service.
 */
export function registerWebCommands(api: ValleyPluginApi, store: WebStore): () => void {
  const browser = createBrowserAutomationService(api, store)
  const offs = [
    api.commands.register({
      id: 'open',
      label: 'Surfing: Open a website in a new tab', labelKey: 'auto.e4ab509cac59',
      paletteSafe: true,
      sideEffect: 'write',
      input: {
        schema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false },
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          return { url: typeof o.url === 'string' ? o.url : '' }
        },
        fromCli: (args) => ({ url: args.join(' ').trim() })
      },
      preview: (input) => input,
      run: async ({ url }) => {
        const result = await browser.open(url)
        if (!result.ok || !result.data) throw new Error(result.error || uiText('surfing.error.openTab'))
        return { value: result.data, revert: null }
      },
      formatCli: (v) => `Opened ${v.url || 'a new tab'} (${v.instanceId}).`
    }),
    api.commands.register({
      id: 'list',
      label: 'Surfing: list open tabs', labelKey: 'auto.f5734ca3ccaf',
      paletteSafe: false,
      sideEffect: 'read',
      usage: 'web list',
      run: () => {
        const snap = store.getSnapshot()
        const tabs = Object.entries(snap.tabs).map(([instanceId, tab]) => ({
          instanceId,
          url: tab.url,
          title: tab.title,
          profileId: tab.profileId
        }))
        return { tabs }
      },
      formatCli: (v) => {
        const { tabs } = v as { tabs: { instanceId: string; url: string; title: string }[] }
        if (!tabs.length) return 'No web tabs open.'
        return tabs.map((t) => `- ${t.title || t.url || 'New tab'} (${t.instanceId}) — ${t.url}`).join('\n')
      }
    }),
    api.commands.register({
      id: 'switch',
      label: 'Surfing: Reveal a browser tab', labelKey: 'auto.f135c4de2eb1',
      paletteSafe: false,
      sideEffect: 'read',
      input: {
        schema: { type: 'object', properties: { instanceId: { type: 'string', minLength: 1 } }, required: ['instanceId'], additionalProperties: false },
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const instanceId = typeof o.instanceId === 'string' ? o.instanceId.trim() : ''
          if (!instanceId) throw new Error(uiText('surfing.error.usage', { value: 'web switch <instanceId>' }))
          return { instanceId }
        },
        fromCli: (args) => ({ instanceId: args.join(' ').trim() })
      },
      run: ({ instanceId }) => {
        if (!store.getTab(instanceId)) throw new Error(uiText('surfing.error.liveTab', { value: instanceId }))
        api.workspace.openMainTab({ instanceId })
        return { instanceId }
      },
      formatCli: (v) => `Revealed tab ${v.instanceId}.`
    }),
    api.commands.register({
      id: 'close',
      label: 'Surfing: Close a browser tab', labelKey: 'auto.09b21c342d80',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: { type: 'object', properties: { instanceId: { type: 'string', minLength: 1 } }, required: ['instanceId'], additionalProperties: false },
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const instanceId = typeof o.instanceId === 'string' ? o.instanceId.trim() : ''
          if (!instanceId) throw new Error(uiText('surfing.error.usage', { value: 'web close <instanceId>' }))
          return { instanceId }
        },
        fromCli: (args) => ({ instanceId: args.join(' ').trim() })
      },
      preview: (input) => input,
      revision: ({ instanceId }) => store.getTab(instanceId),
      run: async ({ instanceId }) => {
        const result = await browser.close(instanceId)
        if (!result.ok) throw new Error(result.error || uiText('surfing.error.closeTab'))
        return { value: { instanceId }, revert: null }
      },
      formatCli: (v) => `Closed tab ${v.instanceId}.`
    }),
    api.commands.register<ClipInput, ClipResult, 'write'>({
      id: 'clip',
      label: 'Surfing: Clip page to Markdown…', labelKey: 'auto.72f4410a7ff5',
      paletteSafe: false,
      sideEffect: 'write',
      usage: 'web clip <instanceId> [--collision keep-both|overwrite|cancel]',
      input: {
        schema: { type: 'object', properties: { instanceId: { type: 'string', minLength: 1 }, collision: { type: 'string', enum: ['keep-both', 'overwrite', 'cancel'], default: 'keep-both' } }, required: ['instanceId'], additionalProperties: false },
        parse: (raw) => {
          const value = (raw ?? {}) as Record<string, unknown>
          if (typeof value.instanceId !== 'string' || !value.instanceId.trim()) throw new Error(uiText('surfing.error.required', { value: 'instanceId' }))
          if (value.collision !== undefined && !['keep-both', 'overwrite', 'cancel'].includes(String(value.collision))) throw new Error(uiText('surfing.error.invalid', { value: 'collision (keep-both, overwrite, cancel)' }))
          const collision: ClipInput['collision'] = value.collision === 'overwrite' || value.collision === 'cancel'
            ? value.collision
            : 'keep-both'
          return {
            instanceId: value.instanceId.trim(),
            collision
          }
        },
        fromCli: (args, flags) => ({ instanceId: args[0] ?? '', collision: flags.collision })
      },
      preview: ({ instanceId, collision }) => ({
        action: 'clip-web-page',
        instanceId,
        targetFolder: 'Clippings',
        collision
      }),
      revision: async ({ instanceId }) => {
        const page = await store.browserReadHtml(instanceId)
        if (!page.ok) throw new Error(page.error || uiText('surfing.error.closedTab'))
        return page.data
      },
      run: async ({ instanceId, collision }) => {
        const response = await store.browserReadHtml(instanceId)
        if (!response.ok || !response.data?.html) throw new Error(response.error || uiText('surfing.error.readPage'))
        const document = new DOMParser().parseFromString(response.data.html, 'text/html')
        const base = document.createElement('base')
        base.href = response.data.url
        document.head.prepend(base)
        const article = new Readability(document).parse()
        if (!article?.content) throw new Error(uiText('surfing.error.noArticle'))
        const cleanHtml = DOMPurify.sanitize(article.content, {
          FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
          FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload']
        })
        const markdown = turndown.turndown(cleanHtml).trim()
        if (!markdown) throw new Error(uiText('surfing.error.noArticle'))
        const title = article.title?.trim() || response.data.title.trim() || 'Untitled clipping'
        const target = await clippingPath(api, title, collision)
        if (!target) return { value: { cancelled: true as const }, revert: null }
        const content = [
          '---',
          `title: ${yamlString(title)}`,
          `source: ${yamlString(response.data.url)}`,
          `clippedAt: ${yamlString(new Date().toISOString())}`,
          '---',
          '',
          `# ${title}`,
          '',
          markdown,
          ''
        ].join('\n')
        if (!(await api.vault.writeFile(target.relPath, content))) throw new Error(uiText('surfing.error.saveClip'))
        return {
          value: { relPath: target.relPath, url: response.data.url, title },
          revert: {
            label: `Clip ${title}`,
            run: async () => {
              if (target.previous !== null) {
                if (!(await api.vault.writeFile(target.relPath, target.previous))) throw new Error(uiText('surfing.error.restorePrevious'))
              } else {
                const removed = await api.drivers.notes.deleteMarkdown({ relPath: target.relPath })
                if (!removed.ok) throw new Error(removed.error || uiText('surfing.error.deleteClip'))
              }
            },
            reapply: async () => {
              if (!(await api.vault.writeFile(target.relPath, content))) throw new Error(uiText('surfing.error.restoreClip'))
            }
          }
        }
      },
      formatCli: (value) => {
        const result = value as { cancelled?: boolean; relPath?: string }
        return result.cancelled ? 'Clipping cancelled.' : `Clipped page to ${result.relPath}.`
      }
    })
  ]
  return () => {
    for (const off of offs) off()
  }
}
