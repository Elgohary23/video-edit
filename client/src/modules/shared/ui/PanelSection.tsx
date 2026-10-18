import { cn } from '../utils'

interface PanelSectionProps {
  title: string
  className?: string
  children?: React.ReactNode
}

/** Rail section with a small uppercase label — shared layout primitive. */
export function PanelSection({ title, className, children }: PanelSectionProps) {
  return (
    <section className={cn('flex flex-col gap-2.5', className)}>
      <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">{title}</h2>
      {children}
    </section>
  )
}
