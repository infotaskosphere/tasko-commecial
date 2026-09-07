import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef(({ className, ...props }, ref) => (
  <>
    <SwitchPrimitives.Root
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className
      )}
      {...props}
      ref={ref}>
      <SwitchPrimitives.Thumb
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
        )} />
    </SwitchPrimitives.Root>
    <style>{`
      /* Client Profile: replace the old square-looking status switch with a
         compact Active / Archive radio-style choice while preserving the
         existing Radix switch state and formData.status behaviour. */
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"] {
        position: relative !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 126px !important;
        min-width: 126px !important;
        height: 32px !important;
        min-height: 32px !important;
        padding: 2px !important;
        border: 1px solid #cbd5e1 !important;
        border-radius: 9999px !important;
        background: #ffffff !important;
        box-shadow: none !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
      }
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"] > span {
        display: none !important;
      }
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"]::before,
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"]::after {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 50% !important;
        height: 26px !important;
        border-radius: 9999px !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        line-height: 1 !important;
        box-sizing: border-box !important;
      }
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"]::before {
        content: "◉  Active" !important;
        color: #047857 !important;
        background: #ecfdf5 !important;
      }
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"]::after {
        content: "○  Archive" !important;
        color: #64748b !important;
        background: transparent !important;
      }
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"][data-state="unchecked"]::before {
        content: "○  Active" !important;
        color: #64748b !important;
        background: transparent !important;
      }
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"][data-state="unchecked"]::after {
        content: "◉  Archive" !important;
        color: #b45309 !important;
        background: #fffbeb !important;
      }
      .bg-slate-50.px-4.py-2.rounded-xl.border button[role="switch"] + span {
        display: none !important;
      }
    `}</style>
  </>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
