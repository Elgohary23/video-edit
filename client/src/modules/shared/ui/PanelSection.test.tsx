import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PanelSection } from './PanelSection'

describe('PanelSection', () => {
  it('renders an uppercase labeled section with its children', () => {
    render(<PanelSection title="Media">content child</PanelSection>)
    expect(screen.getByRole('heading', { name: 'Media', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('content child')).toBeInTheDocument()
  })
  it('accepts extra classes', () => {
    const { container } = render(<PanelSection title="X" className="mt-4" />)
    expect(container.firstElementChild).toHaveClass('mt-4')
  })
})
