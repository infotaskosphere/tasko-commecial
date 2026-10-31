import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/*
 * Header band for hand-built popups (the ones that don't use DialogHeader).
 * Same look as the Create Invoice popup and the shared DialogHeader:
 * navy gradient, square icon tile, optional eyebrow, white title and
 * subtitle, optional actions and a translucent close button.
 */
export const POPUP_GRADIENT = "linear-gradient(135deg, #0D3B66, #1F6FB2)"

export function PopupHeader({
  icon: Icon,
  iconNode,
  eyebrow,
  title,
  subtitle,
  actions,
  onClose,
  closeDisabled = false,
  className,
  titleAs: TitleTag = "h2",
  titleProps,
}) {
  return (
    <div
      className={cn("relative flex-shrink-0 overflow-hidden px-6 py-5 text-white", className)}
      style={{ background: POPUP_GRADIENT }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 opacity-10"
        style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }}
      />
      <div className="relative flex min-w-0 items-center gap-3">
        {(Icon || iconNode) && (
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center bg-white/15 text-white">
            {iconNode || <Icon className="h-5 w-5" />}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {eyebrow && <p className="text-[10px] uppercase tracking-[0.2em] text-white/55">{eyebrow}</p>}
          <TitleTag className="break-words text-xl font-bold leading-snug text-white" {...titleProps}>{title}</TitleTag>
          {subtitle && <div className="mt-0.5 break-words text-[13px] leading-snug text-white/75">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center bg-white/15 text-white transition-colors hover:bg-white/25 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}

export default PopupHeader
