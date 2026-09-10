import { createMockValleyApi as createApi } from '@valley/plugin-testkit'
import { vi } from 'vitest'

export function createMockValleyApi(options: Parameters<typeof createApi>[0] = {}) {
  const mock = createApi({ ...options, manifest: { id: 'surfing', ...options.manifest } })
  vi.mocked(mock.api.backend.call).mockImplementation(async () => ({ styles: '', scripts: [] }) as never)
  return mock
}
