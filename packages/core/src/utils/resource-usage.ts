export interface ResourceUsageSample {
  cpuMs: number;
  peakRssBytes: number;
}

export interface ResourceProbe {
  cpuUsage(): { user: number; system: number };
  rss(): number;
}

const processProbe: ResourceProbe = { cpuUsage: () => process.cpuUsage(), rss: () => process.memoryUsage.rss() };
const noopMeter = { stop: (): ResourceUsageSample | undefined => undefined };

export function startResourceMeter(probe: ResourceProbe = processProbe, sampleIntervalMs = 1000) {
  try {
    const start = probe.cpuUsage();
    let peak = probe.rss();
    const timer = setInterval(() => {
      try {
        peak = Math.max(peak, probe.rss());
      } catch {
        peak = NaN;
      }
    }, sampleIntervalMs);
    timer.unref();
    return {
      stop(): ResourceUsageSample | undefined {
        clearInterval(timer);
        try {
          const end = probe.cpuUsage();
          peak = Math.max(peak, probe.rss());
          const cpuMs = Math.max(0, Math.round((end.user - start.user + end.system - start.system) / 1000));
          return Number.isFinite(cpuMs) && Number.isFinite(peak)
            ? { cpuMs, peakRssBytes: Math.round(peak) }
            : undefined;
        } catch {
          return undefined;
        }
      },
    };
  } catch {
    return noopMeter;
  }
}
