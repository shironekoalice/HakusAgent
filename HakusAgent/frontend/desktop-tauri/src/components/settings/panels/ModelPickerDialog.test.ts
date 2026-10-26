import { describe, expect, it } from 'vitest'

import {
  formatContextWindow,
  mergeModelIds,
  pendingAdditions,
  presetPickedIds,
  toggleVisibleSelection,
  type DiscoveredModel,
} from './ModelPickerDialog'

/**
 * The multi-select model picker's behaviour, ported from the DeepSeek Harness
 * settings-models client. Each case here pins a decision that is easy to get
 * wrong and invisible until a user loses work, so they are tested as pure
 * functions rather than through a rendered dialog.
 */
const model = (id: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
  id,
  ...extra,
})

describe('presetPickedIds', () => {
  it('pre-ticks only the models the caller does not already have', () => {
    const picked = presetPickedIds(
      [model('a'), model('b'), model('c')],
      ['a', 'c'],
    )
    expect([...picked]).toEqual(['b'])
  })

  it('matches case-insensitively, so a recased id is not added twice', () => {
    const picked = presetPickedIds([model('GLM-5.3')], ['glm-5.3'])
    expect([...picked]).toEqual([])
  })

  it('pre-ticks everything on a first fetch', () => {
    const picked = presetPickedIds([model('a'), model('b')], [])
    expect(picked.size).toBe(2)
  })
})

describe('toggleVisibleSelection', () => {
  const visible = [model('a'), model('b')]

  it('selects the visible rows when not all of them are selected', () => {
    const next = toggleVisibleSelection(new Set(['a']), visible)
    expect([...next].sort()).toEqual(['a', 'b'])
  })

  it('clears the visible rows when all of them are selected', () => {
    const next = toggleVisibleSelection(new Set(['a', 'b']), visible)
    expect([...next]).toEqual([])
  })

  // A filtered-away row is not on screen, so a button the user can see must not
  // silently change it.
  it('never touches a selection that the search filter is hiding', () => {
    const next = toggleVisibleSelection(new Set(['hidden']), visible)
    expect(next.has('hidden')).toBe(true)
    expect([...next].sort()).toEqual(['a', 'b', 'hidden'])
  })

  it('leaves the re-selected state holding the hidden row', () => {
    const all = toggleVisibleSelection(new Set(['hidden', 'a', 'b']), visible)
    expect([...all]).toEqual(['hidden'])
  })

  it('is a no-op on an empty visible set', () => {
    const current = new Set(['a'])
    expect([...toggleVisibleSelection(current, [])]).toEqual(['a'])
  })
})

describe('pendingAdditions', () => {
  it('returns ticked ids that are not already configured', () => {
    const additions = pendingAdditions(
      [model('a'), model('b'), model('c')],
      new Set(['a', 'b', 'c']),
      ['a'],
    )
    expect(additions).toEqual(['b', 'c'])
  })

  it('preserves the response order', () => {
    const additions = pendingAdditions(
      [model('z'), model('a'), model('m')],
      new Set(['z', 'a', 'm']),
      [],
    )
    expect(additions).toEqual(['z', 'a', 'm'])
  })

  it('drops ticked ids the caller already has', () => {
    expect(pendingAdditions([model('a')], new Set(['a']), ['a'])).toEqual([])
  })
})

describe('mergeModelIds', () => {
  // The fetch must not discard a row the user renamed or configured first.
  it('appends without reordering or replacing existing rows', () => {
    const merged = mergeModelIds(['kept', 'mine'], ['new'])
    expect(merged).toEqual(['kept', 'mine', 'new'])
  })

  it('skips duplicates case-insensitively', () => {
    expect(mergeModelIds(['GLM-5.3'], ['glm-5.3'])).toEqual(['GLM-5.3'])
  })

  it('returns the same reference when there is nothing to add', () => {
    const current = ['a']
    expect(mergeModelIds(current, [])).toBe(current)
    expect(mergeModelIds(current, ['a'])).toBe(current)
  })

  it('adds only the genuinely new ids from a mixed batch', () => {
    expect(mergeModelIds(['a'], ['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('formatContextWindow', () => {
  it('renders a million tokens as 1M regardless of locale', () => {
    // Pinned to en-US on purpose: a zh-CN Intl would say "100万", which no
    // provider's documentation uses.
    expect(formatContextWindow(1_000_000)).toBe('1M')
  })

  it('renders thousands compactly', () => {
    expect(formatContextWindow(256_000)).toBe('256K')
    expect(formatContextWindow(131_072)).toBe('131K')
  })

  it('has no label for a missing or nonsensical capacity', () => {
    expect(formatContextWindow(null)).toBeNull()
    expect(formatContextWindow(undefined)).toBeNull()
    expect(formatContextWindow(0)).toBeNull()
    expect(formatContextWindow(-1)).toBeNull()
    expect(formatContextWindow(Number.NaN)).toBeNull()
  })
})
