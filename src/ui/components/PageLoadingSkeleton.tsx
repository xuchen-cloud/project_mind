interface PageLoadingSkeletonProps {
  variant: "overview" | "record";
  label: string;
  testId?: string;
}

export function PageLoadingSkeleton({ variant, label, testId }: PageLoadingSkeletonProps) {
  return (
    <div
      className="page-loading-skeleton"
      role="status"
      aria-label={label}
      aria-live="polite"
      aria-busy="true"
      data-variant={variant}
      data-testid={testId}
    >
      <span className="sr-only">{label}</span>
      <div className="page-loading-skeleton__chrome" aria-hidden="true">
        <div className="page-loading-skeleton__chrome-inner">
          <span className="page-loading-skeleton__block page-loading-skeleton__title" />
          <span className="page-loading-skeleton__block page-loading-skeleton__meta" />
        </div>
      </div>
      <div className="page-loading-skeleton__body" aria-hidden="true">
        {variant === "record" ? (
          <span className="page-loading-skeleton__block page-loading-skeleton__record-title" />
        ) : null}
        <div className="page-loading-skeleton__tag-row">
          <span className="page-loading-skeleton__block page-loading-skeleton__tag" />
          <span className="page-loading-skeleton__block page-loading-skeleton__tag page-loading-skeleton__tag--short" />
        </div>
        <span className="page-loading-skeleton__block page-loading-skeleton__line" />
        <span className="page-loading-skeleton__block page-loading-skeleton__line page-loading-skeleton__line--medium" />
        <span className="page-loading-skeleton__block page-loading-skeleton__line page-loading-skeleton__line--short" />
      </div>
    </div>
  );
}
