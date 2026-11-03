import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ICON_NAMES } from '../../shared/layout/icons'
import { ContributionIcon, ICONS, Icon } from '../../tessera-ui'

describe('the icon registry', () => {
  it('has exactly one component for every name the main process accepts', () => {
    expect(Object.keys(ICONS).sort()).toEqual([...ICON_NAMES].sort())
    for (const name of ICON_NAMES) expect(ICONS[name], name).toBeTypeOf('object')   // memo/forwardRef exotic components
  })

  it('draws a named icon as a Material SVG tagged with its name', () => {
    const { container } = render(<Icon name="Save" fontSize="small" />)
    const svg = container.querySelector('svg[data-icon="Save"]')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg!.querySelector('path')).toBeInTheDocument()
  })
})

describe('a contribution icon', () => {
  it('draws a shell icon name as that icon', () => {
    const { container } = render(<ContributionIcon icon="Home" title="Home page" />)
    expect(container.querySelector('svg[data-icon="Home"]')).toBeInTheDocument()
  })

  it('paints a plugin file through a mask in the current colour', () => {
    const url = 'tessera-plugin://p/icons/a.svg'
    const { container } = render(<ContributionIcon icon={url} title="Accounts" />)
    const box = container.querySelector(`[data-icon="${url}"]`) as HTMLElement
    expect(box).toBeInTheDocument()
    expect(box.tagName).toBe('SPAN')
    expect(box).toHaveAttribute('aria-hidden', 'true')
    // The style Emotion emitted for the box: the file is a mask over the current text colour.
    const rule = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n')
      .split('}').find(r => r.includes(`.${box.className.split(' ').pop()}`))
    expect(rule).toMatch(/background-color:\s*currentColor/i)
    expect(rule).toMatch(new RegExp(`mask:\\s*url\\("${url}"\\)`))
  })

  it('falls back to the initial of the title', () => {
    const { container } = render(<ContributionIcon title="accounts" />)
    const box = container.querySelector('[data-icon]') as HTMLElement
    expect(box).toHaveTextContent('A')
    expect(box).toHaveAttribute('aria-hidden', 'true')
  })

  it('treats an unknown name like a missing icon', () => {
    const { container } = render(<ContributionIcon icon="NotAnIcon" title="Budget" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('[data-icon]')).toHaveTextContent('B')
  })
})
