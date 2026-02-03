/**
 * Skeleton Component
 * Displays a shimmer loading placeholder for better UX during data fetching.
 *
 * Usage:
 * <Skeleton className="h-4 w-32" />
 * <Skeleton className="h-12 w-12 rounded-full" />
 */

import { cn } from "@/lib/utils";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Whether to show shimmer animation */
  shimmer?: boolean;
}

export function Skeleton({ className, shimmer = true, ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        "bg-zinc-800 rounded",
        shimmer && "relative overflow-hidden before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-zinc-700/50 before:to-transparent",
        className
      )}
      {...props}
    />
  );
}

/**
 * Skeleton variants for common use cases
 */
export function SkeletonText({ className, lines = 1 }: { className?: string; lines?: number }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn(
            "h-4",
            i === lines - 1 && lines > 1 ? "w-3/4" : "w-full"
          )}
        />
      ))}
    </div>
  );
}

export function SkeletonAvatar({ className, size = "md" }: { className?: string; size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "h-8 w-8",
    md: "h-12 w-12",
    lg: "h-20 w-20",
  };

  return <Skeleton className={cn("rounded-full", sizeClasses[size], className)} />;
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("bg-zinc-900 rounded-2xl p-5 border border-zinc-800", className)}>
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <SkeletonAvatar />
          <div className="space-y-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
        <div className="text-right space-y-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-7 w-20" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-5">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
      </div>
      <Skeleton className="h-2 rounded-full mb-4" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-24" />
      </div>
    </div>
  );
}

/**
 * Skeleton for volume/price values that preserves layout
 */
export function SkeletonValue({ className, width = "w-20" }: { className?: string; width?: string }) {
  return <Skeleton className={cn("h-7", width, className)} />;
}
