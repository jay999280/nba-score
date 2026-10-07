/**
 * The centred content column.
 *
 * Mobile-first at 375–430px; on a desktop the column stays bounded instead of
 * stretching phone cards across the window (PRD §22).
 */
export function Shell({
  children,
  width = "max-w-[680px]",
}: {
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <div className={`mx-auto flex w-full flex-col gap-5 px-4 pt-5 pb-24 sm:px-5 ${width}`}>
      {children}
    </div>
  );
}
