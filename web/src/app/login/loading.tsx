import { Skeleton } from "@/components/ui/skeleton";

export default function LoginLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12" aria-label="Loading sign in">
      <section className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-xl sm:p-8">
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-7 w-32" />
        </div>
        <Skeleton className="mt-6 h-6 w-24" />
        <Skeleton className="mt-2 h-4 w-full" />
        <div className="mt-6 space-y-4">
          <div>
            <Skeleton className="mb-1.5 h-4 w-20" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
          <Skeleton className="h-11 w-full rounded-full" />
        </div>
      </section>
    </main>
  );
}
