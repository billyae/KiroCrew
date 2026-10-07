import { afterEach, describe, expect, it } from 'vitest'

import { i18next } from './index'
import './all'
import { i18nT } from './t'

const KEY = 'pages.chat.activityViewer.tool_calls_not_listed'

afterEach(async () => {
  if (i18next.language !== 'en') await i18next.changeLanguage('en')
})

describe('subagent card unlisted tool-call count', () => {
  it('takes the singular form for one call in languages that inflect it', async () => {
    await i18next.changeLanguage('fr')
    expect(i18nT(KEY, { count: 1 })).toBe('1 autre non affiché')
    expect(i18nT(KEY, { count: 3 })).toBe('3 autres non affichés')
    await i18next.changeLanguage('it')
    expect(i18nT(KEY, { count: 1 })).toBe('Altra 1 non elencata')
    await i18next.changeLanguage('pt')
    expect(i18nT(KEY, { count: 1 })).toBe('Mais 1 não listada')
  })
})
