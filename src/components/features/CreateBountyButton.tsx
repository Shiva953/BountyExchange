"use client";

import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";

interface CreateBountyButtonProps {
  onClick: () => void;
}

export const CreateBountyButton = ({ onClick }: CreateBountyButtonProps) => {
  return (
    <Button
      onClick={onClick}
      size="lg"
      className="gap-4 rounded-full px-6 py-6 text-sm font-semibold tracking-tight cursor-pointer"
    >
      <span>Create Bounty</span>
      <span className="flex items-center justify-center size-10 bg-primary-foreground text-primary rounded-full">
        <PlusIcon className="size-5" />
      </span>
    </Button>
  );
};
