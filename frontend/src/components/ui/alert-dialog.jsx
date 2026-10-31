import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import {
  DialogOverlay,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  PopupContent,
} from "@/components/ui/dialog"

// Confirmation popups share the app-wide popup shell (see dialog.jsx), so they
// get the same header band, footer bar and overflow protection.

const AlertDialog = DialogPrimitive.Root

const AlertDialogTrigger = DialogPrimitive.Trigger

const AlertDialogPortal = DialogPrimitive.Portal

const AlertDialogOverlay = DialogOverlay

const AlertDialogContent = React.forwardRef(({ hideClose = true, ...props }, ref) => (
  <PopupContent ref={ref} hideClose={hideClose} {...props} />
))
AlertDialogContent.displayName = "AlertDialogContent"

const AlertDialogHeader = (props) => <DialogHeader {...props} />
AlertDialogHeader.displayName = "AlertDialogHeader"

const AlertDialogFooter = (props) => <DialogFooter {...props} />
AlertDialogFooter.displayName = "AlertDialogFooter"

const AlertDialogTitle = React.forwardRef((props, ref) => <DialogTitle ref={ref} {...props} />)
AlertDialogTitle.displayName = "AlertDialogTitle"

const AlertDialogDescription = React.forwardRef((props, ref) => <DialogDescription ref={ref} {...props} />)
AlertDialogDescription.displayName = "AlertDialogDescription"

const AlertDialogAction = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} className={cn(buttonVariants(), className)} {...props} />
))
AlertDialogAction.displayName = "AlertDialogAction"

const AlertDialogCancel = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    className={cn(buttonVariants({ variant: "outline" }), className)}
    {...props} />
))
AlertDialogCancel.displayName = "AlertDialogCancel"

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
