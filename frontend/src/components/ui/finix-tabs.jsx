import * as React from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import "./finix-compact-ui.css";

/**
 * Finix compact tab bar.
 *
 * One shared definition so Accounting Reports and Zero-Touch Entry (and any
 * page that adopts it later) always render tabs with the SAME height, width
 * behaviour, padding and colours. All geometry lives in ./finix-compact-ui.css.
 *
 * Usage:
 *   <Tabs value={tab} onValueChange={setTab}>
 *     <FinixTabsList>
 *       <FinixTabsTrigger value="a">Tab A</FinixTabsTrigger>
 *       <FinixTabsTrigger value="b">Tab B</FinixTabsTrigger>
 *     </FinixTabsList>
 *     <TabsContent value="a">...</TabsContent>
 *   </Tabs>
 */
export const FinixTabsList = React.forwardRef(({ className, ...props }, ref) => (
  <TabsList ref={ref} className={cn("finix-tabs", className)} {...props} />
));
FinixTabsList.displayName = "FinixTabsList";

export const FinixTabsTrigger = React.forwardRef(({ className, ...props }, ref) => (
  <TabsTrigger ref={ref} className={cn("finix-tab", className)} {...props} />
));
FinixTabsTrigger.displayName = "FinixTabsTrigger";
