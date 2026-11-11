/**
 * Type declarations for the DSH UI primitives the browser half uses. The module itself is provided at runtime by
 * the DSH page's module table, so the package never bundles it.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ForwardRefExoticComponent, ReactElement, ReactNode, RefAttributes } from 'react'
  export const Button: ForwardRefExoticComponent<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>>
  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    tone?: 'warning'
    description?: string
    closeLabel: string
    children?: ReactNode
    footer?: ReactNode
  }): ReactNode
  export function Tooltip(props: {
    label: string
    side?: 'top' | 'right' | 'bottom' | 'left'
    align?: 'center' | 'end'
    delayMs?: number
    portal?: boolean
    children: ReactElement
  }): ReactNode
  export function IconTrashOutlineRegular(props: { size?: number; className?: string }): ReactNode
}
