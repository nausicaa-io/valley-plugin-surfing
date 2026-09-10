import type { ValleyPluginApi } from '@valley/plugin-sdk'

const FEATURES = `(() => {
  const classes = new Set(), ids = new Set(), hrefs = new Set();
  for (const element of document.querySelectorAll('[class],[id],a[href]')) {
    for (const name of element.classList) if (name.length <= 128 && classes.size < 1000) classes.add(name);
    if (element.id && element.id.length <= 128 && ids.size < 1000) ids.add(element.id);
    const href = element.getAttribute('href'); if (href && href.length <= 2048 && hrefs.size < 1000) hrefs.add(href);
  }
  return {url:location.href,classes:[...classes],ids:[...ids],hrefs:[...hrefs]};
})()`

export function watchBrowserCosmetics(api: ValleyPluginApi, guestId: string, partition: string): () => void {
  let active = true
  let pending = false
  let initial = true
  let previous = ''
  const styles = new Set<string>()
  const update = async (): Promise<void> => {
    if (!active || pending) return
    pending = true
    try {
      const features = await api.drivers.browser.execute(guestId, FEATURES)
      if (!features.ok || !features.data) return
      const signature = JSON.stringify(features.data)
      if (signature === previous) return
      const result = await api.backend.call<{ styles: string; scripts: string[] }>('filter.cosmetics', { partition, ...(features.data as object), initial })
      if (!active) return
      previous = signature
      initial = false
      if (result.styles && !styles.has(result.styles)) {
        styles.add(result.styles)
        const css = [...styles].join('\n')
        if (css.length <= 1024 * 1024) await api.drivers.browser.styles(guestId, 'page-filter', css)
      }
      for (const script of result.scripts) if (active) await api.drivers.browser.execute(guestId, script, true)
    } catch (error) { console.error(error) }
    finally { pending = false }
  }
  const off = api.backend.on('filter.changed', () => { previous = ''; initial = true; styles.clear(); void api.drivers.browser.styles(guestId, 'page-filter', '').then(() => update()) })
  void update()
  const timer = setInterval(() => void update(), 2000)
  return () => { active = false; off(); clearInterval(timer) }
}
