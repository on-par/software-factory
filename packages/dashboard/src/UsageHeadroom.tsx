import { toUsageHeadroomView, type UsageHeadroomReading } from './usageHeadroomState.js';

export interface UsageHeadroomProps {
  /** The current reading, or `null` when no usage signal is available. `null` is a real
   *  state, not a placeholder: it must never be rendered as 0% or as an armed watchdog. */
  usage: UsageHeadroomReading | null;
}

export function UsageHeadroom({ usage }: UsageHeadroomProps) {
  const view = toUsageHeadroomView(usage);

  return (
    <section aria-label="Usage headroom" className="flex flex-col gap-1 rounded-md border border-hairline bg-white p-2">
      <h4 className="text-sm font-semibold text-ink-900">Usage headroom</h4>
      {view.available ? (
        <>
          <div className="h-1 rounded-sm bg-hairline">
            <div
              role="progressbar"
              aria-label="Usage of cap"
              aria-valuenow={view.pctValue}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1 rounded-sm bg-status-building"
              style={{ width: `${Math.min(100, view.pctValue)}%` }}
            />
          </div>
          <dl className="grid grid-cols-2 gap-x-2 text-xs">
            <dt className="text-ink-600">Usage</dt>
            <dd className="text-ink-900">{view.pctLabel}</dd>
            <dt className="text-ink-600">Cap</dt>
            <dd className="text-ink-900">{view.capLabel}</dd>
            <dt className="text-ink-600">Source</dt>
            <dd className="text-ink-900">{view.sourceLabel}</dd>
            <dt className="text-ink-600">Next poll</dt>
            <dd className="text-ink-900">{view.nextPollLabel}</dd>
          </dl>
        </>
      ) : (
        <p role="status" className="text-xs text-ink-600">
          {view.reason}
        </p>
      )}
    </section>
  );
}
