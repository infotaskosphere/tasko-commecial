import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import "./dialog.css"

/*
 * App-wide popup shell. Every popup built from these parts shares the look of
 * the Create Invoice popup: a navy gradient header band (icon tile, optional
 * eyebrow, white title and description), a plain body and a light footer bar.
 *
 * Content never spills out of the box: the body is a single grid column that is
 * allowed to shrink (minmax(0,1fr)), long words wrap, and the box itself is
 * capped to the viewport and scrolls when it is taller than the screen.
 *
 * The header and footer bands bleed to the box edges whatever padding a popup
 * uses: DialogContent measures its own padding into --dlg-pt/pr/pb/pl, and the
 * bands use those values as negative margins.
 */

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-emerald-900/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props} />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

// Helper: check if children already contain a DialogTitle
function hasDialogTitle(children) {
  let found = false;
  React.Children.forEach(children, child => {
    if (!child) return;
    if (child.type === DialogPrimitive.Title || child.type === DialogTitle) { found = true; return; }
    if (child.props?.children) {
      if (hasDialogTitle(child.props.children)) found = true;
    }
  });
  return found;
}

// Copies the popup's computed padding into CSS variables so the header and
// footer bands can bleed to the edges, whatever padding classes it was given.
function usePaddingVars(ref) {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const sync = () => {
      const cs = window.getComputedStyle(el);
      el.style.setProperty("--dlg-pt", cs.paddingTop);
      el.style.setProperty("--dlg-pr", cs.paddingRight);
      el.style.setProperty("--dlg-pb", cs.paddingBottom);
      el.style.setProperty("--dlg-pl", cs.paddingLeft);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  });
}

function useMergedRef(forwarded) {
  const local = React.useRef(null);
  const setRef = React.useCallback((node) => {
    local.current = node;
    if (typeof forwarded === "function") forwarded(node);
    else if (forwarded) forwarded.current = node;
  }, [forwarded]);
  return [local, setRef];
}

// Lets a header band host the close button, so it stays visible while the
// body scrolls (the band is sticky; the box corner is not).
const PopupContext = React.createContext(null)

// Shared by Dialog and AlertDialog.
const POPUP_CLASSES =
  "fixed left-[50%] top-[50%] z-50 grid grid-cols-[minmax(0,1fr)] gap-4 w-[calc(100vw-1.5rem)] max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain translate-x-[-50%] translate-y-[-50%] border border-slate-200 bg-background p-6 shadow-2xl break-words duration-200 dark:border-slate-700 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg"

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const PopupContent = React.forwardRef(({ className, children, hideClose = false, onOpenAutoFocus, ...props }, ref) => {
  const [local, setRef] = useMergedRef(ref)
  usePaddingVars(local)
  // The close button now comes first in the DOM (in the header band). Keep
  // the old behaviour of focusing the first control in the body on open.
  const handleOpenAutoFocus = React.useCallback((event) => {
    onOpenAutoFocus?.(event)
    if (event.defaultPrevented) return
    const el = local.current
    if (!el) return
    const first = Array.from(el.querySelectorAll(FOCUSABLE)).find((node) => !node.closest("[data-dialog-close]"))
    event.preventDefault()
    ;(first || el).focus({ preventScroll: true })
  }, [onOpenAutoFocus, local])
  const [headerClose, setHeaderClose] = React.useState(0)
  const ctx = React.useMemo(() => ({ hideClose, setHeaderClose }), [hideClose])
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={setRef}
        data-app-dialog=""
        className={cn(POPUP_CLASSES, className)}
        aria-describedby={undefined}
        tabIndex={-1}
        onOpenAutoFocus={handleOpenAutoFocus}
        {...props}>
        {/* Auto-inject visually-hidden title if none present — satisfies Radix accessibility requirement */}
        {!hasDialogTitle(children) && (
          <DialogPrimitive.Title className="sr-only">Dialog</DialogPrimitive.Title>
        )}
        <PopupContext.Provider value={ctx}>{children}</PopupContext.Provider>
        {!hideClose && !headerClose && (
          <DialogPrimitive.Close
            data-dialog-close=""
            className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
PopupContent.displayName = "PopupContent"

const DialogContent = React.forwardRef((props, ref) => <PopupContent ref={ref} {...props} />)
DialogContent.displayName = DialogPrimitive.Content.displayName

/*
 * Header band. Optional props:
 *   icon    – a lucide icon component shown in the square tile
 *   eyebrow – small uppercase line above the title (e.g. "New document")
 * A leading icon placed inside DialogTitle is shown as the tile automatically.
 * `className="sr-only"` keeps a header hidden, as before.
 */
const DialogHeader = ({ className, icon: Icon, eyebrow, children, ...props }) => {
  const popup = React.useContext(PopupContext)
  const hidden = /(^|\s)sr-only(\s|$)/.test(className || "")
  const ownsClose = !!popup && !hidden && !popup.hideClose
  React.useLayoutEffect(() => {
    if (!ownsClose) return undefined
    popup.setHeaderClose((n) => n + 1)
    return () => popup.setHeaderClose((n) => n - 1)
  }, [ownsClose, popup])
  if (hidden) {
    return <div className={className} {...props}>{children}</div>
  }
  return (
    <div data-dialog-header="" className={cn("dialog-band-header", className)} {...props}>
      <div aria-hidden="true" className="dialog-band-glow" />
      <div className="relative flex min-w-0 items-center gap-3">
        {Icon && <div className="dialog-band-icon"><Icon className="h-5 w-5" /></div>}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {eyebrow && <p className="dialog-band-eyebrow">{eyebrow}</p>}
          {children}
        </div>
      </div>
      {ownsClose && (
        <DialogPrimitive.Close data-dialog-close="" className="dialog-band-close">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}) => (
  <div
    data-dialog-footer=""
    className={cn("dialog-band-footer flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end", className)}
    {...props} />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-dialog-title=""
    className={cn("min-w-0 text-lg font-semibold leading-snug tracking-tight break-words", className)}
    {...props} />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-dialog-description=""
    className={cn("text-sm text-muted-foreground break-words", className)}
    {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  PopupContent,
}
