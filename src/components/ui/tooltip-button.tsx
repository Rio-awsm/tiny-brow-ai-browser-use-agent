import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Props = React.ComponentProps<typeof Button> & {
  tip: string;
  side?: "top" | "bottom" | "left" | "right";
};

export function TooltipButton({ tip, side = "top", children, ...props }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{tip}</TooltipContent>
    </Tooltip>
  );
}
