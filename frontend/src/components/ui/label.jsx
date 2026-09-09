import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const labelVariants = cva(
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
)

const Label = React.forwardRef(({ className, children, htmlFor, ...props }, ref) => {
  // A native <label> without a matching control is reported by Chrome's
  // accessibility checker. FormLabel always supplies htmlFor; for generic
  // standalone label text, render a span instead of creating an orphan label.
  if (!htmlFor) {
    const nestedControl = React.Children.toArray(children).some((child) => (
      React.isValidElement(child)
      && typeof child.type === 'string'
      && ['input', 'select', 'textarea'].includes(child.type)
    ));

    if (!nestedControl) {
      return (
        <span ref={ref} className={cn(labelVariants(), className)} {...props}>
          {children}
        </span>
      );
    }
  }

  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(labelVariants(), className)}
      htmlFor={htmlFor}
      {...props}
    >
      {children}
    </LabelPrimitive.Root>
  );
})
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
