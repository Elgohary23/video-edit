import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App shell', () => {
  it('renders brand and primary actions', () => {
    render(<App />)
    expect(screen.getByText('Cut')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save project' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export MP4' })).toBeInTheDocument()
  })

  it('shows the timeline placeholder', () => {
    render(<App />)
    expect(screen.getByText('Timeline')).toBeInTheDocument()
  })
})
