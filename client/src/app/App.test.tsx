import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App shell', () => {
  it('renders brand and primary actions in header and transport', () => {
    render(<App />)
    expect(screen.getByText('Cut')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save project' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Export video' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Load project' })).toBeInTheDocument()
  })

  it('shows the no-media empty state and timeline hints', () => {
    render(<App />)
    expect(screen.getByText('No media loaded')).toBeInTheDocument()
    expect(screen.getByText('Import video or images to begin')).toBeInTheDocument()
    expect(screen.getByLabelText('Audio waveform')).toBeInTheDocument()
  })
})
