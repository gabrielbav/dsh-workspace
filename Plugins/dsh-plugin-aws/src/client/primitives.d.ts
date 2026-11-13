/**
 * Type declarations for the DSH UI primitives the browser half uses. The module itself is provided at runtime by
 * the DSH page's module table, so the package never bundles it.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ForwardRefExoticComponent, InputHTMLAttributes, ReactNode, RefAttributes } from 'react'
  export const Button: ForwardRefExoticComponent<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>>
  export const Input: ForwardRefExoticComponent<{
    icon?: ReactNode
    className?: string
  } & InputHTMLAttributes<HTMLInputElement> & RefAttributes<HTMLInputElement>>
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
  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string
    children?: ReactNode
  }): ReactNode
  export function StateDot(props: {
    state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
    size?: number
    className?: string
  }): ReactNode
  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string | undefined
    className?: string | undefined
  }): ReactNode
  export function Checkbox(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string | undefined
    className?: string | undefined
  }): ReactNode
}
