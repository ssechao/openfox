/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DisplayTab } from './DisplayTab'
import { setLocale } from '@shared/i18n/index.js'

vi.mock('wouter', () => ({
  useLocation: () => ['/', vi.fn()],
}))

const { mockSettings, mockSetSetting } = vi.hoisted(() => ({
  mockSettings: {} as Record<string, string>,
  mockSetSetting: vi.fn(),
}))

vi.mock('../../../hooks/useSetting', () => ({
  useSetting: (key: string, fallback = '') => ({ value: mockSettings[key] ?? fallback, loading: false }),
}))

vi.mock('../../../lib/resources', async (importOriginal) => ({
  ...(await importOriginal()),
  setSetting: mockSetSetting,
}))

vi.mock('../../../lib/fonts', async (importOriginal) => ({
  ...(await importOriginal()),
  detectAvailableFonts: () => ['JetBrains Mono'],
  resolveDefaultFamily: () => 'JetBrains Mono',
}))

describe('DisplayTab feed virtualization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.keys(mockSettings).forEach((k) => delete mockSettings[k])
    setLocale('en')
  })

  it('renders the three virtualization options and persists the choice', async () => {
    const user = userEvent.setup()
    render(<DisplayTab />)
    const select = screen.getByLabelText('Virtualize long feeds') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['auto', 'on', 'off'])
    expect(select.value).toBe('auto')

    await user.selectOptions(select, 'off')
    expect(mockSetSetting).toHaveBeenCalledWith('display.feedVirtualization', 'off')
  })

  it('normalizes a legacy true value to on', () => {
    mockSettings['display.feedVirtualization'] = 'true'
    render(<DisplayTab />)
    const select = screen.getByLabelText('Virtualize long feeds') as HTMLSelectElement
    expect(select.value).toBe('on')
  })
})

describe('DisplayTab Language setting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.keys(mockSettings).forEach((k) => delete mockSettings[k])
    setLocale('en')
  })

  it('renders the Language section', () => {
    render(<DisplayTab />)
    expect(screen.getByText('Language')).toBeTruthy()
    expect(screen.getByLabelText('Language')).toBeTruthy()
  })

  it('shows the three language options', () => {
    render(<DisplayTab />)
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['automatic', 'en', 'fr'])
  })

  it('persists the chosen locale and applies it', async () => {
    const user = userEvent.setup()
    render(<DisplayTab />)
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    await user.selectOptions(select, 'fr')
    expect(mockSetSetting).toHaveBeenCalledWith('display.locale', 'fr')
  })
})
