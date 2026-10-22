/**
 * Loading placeholders that mirror the real geometry, so nothing shifts when
 * the data lands (PRD §32).
 */

export function GameCardSkeleton() {
  return (
    <div className="card animate-fade px-4 py-3">
      <div className="flex flex-col gap-2">
        <TeamRowSkeleton />
        <TeamRowSkeleton />
      </div>
      <div className="mt-3 flex h-4 items-center">
        <span className="h-2.5 w-14 rounded-full bg-line-strong" />
      </div>
    </div>
  );
}

function TeamRowSkeleton() {
  return (
    <div className="flex h-6 items-center gap-2">
      <span className="size-[22px] shrink-0 rounded-full bg-line-strong" />
      <span className="h-3 w-24 rounded-full bg-line-strong" />
      <span className="ml-auto h-3.5 w-9 rounded-full bg-line-strong" />
    </div>
  );
}

/** Three cards, as the home list would look on a normal day. */
export function GameListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <GameCardSkeleton key={index} />
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="animate-fade flex flex-col gap-8" aria-hidden="true">
      <div className="flex items-end justify-center gap-8 pt-2">
        <div className="flex flex-1 flex-col items-center gap-3">
          <span className="size-11 rounded-full bg-line-strong" />
          <span className="h-3 w-20 rounded-full bg-line-strong" />
          <span className="h-8 w-14 rounded-inner bg-line-strong" />
        </div>
        <div className="flex flex-1 flex-col items-center gap-3">
          <span className="size-11 rounded-full bg-line-strong" />
          <span className="h-3 w-20 rounded-full bg-line-strong" />
          <span className="h-8 w-14 rounded-inner bg-line-strong" />
        </div>
      </div>
      <div className="card h-24" />
      <div className="card h-40" />
    </div>
  );
}
