export interface ResourceUsageSample {
  cpuMs: number;
  peakRssBytes: number;
}

export interface ResourceProbe {
  cpuUsage(): { user: number; system: number };
  rss(): number;
}

const processProbe: ResourceProbe = { cpuUsage: () => process.cpuUsage(), rss: () => process.memoryUsage.rss() };

export function startResourceMeter(probe: ResourceProbe = processProbe, sampleIntervalMs = 1000) {
  let peak = NaN;
  let start = { user: NaN, system: NaN };
  let timer: NodeJS.Timeout | undefined;
  const sample = () => {
    try {
      peak = Math.max(peak, probe.rss());
    } catch {
      peak = NaN;
    }
  };
  try {
    start = probe.cpuUsage();
    peak = probe.rss();
    timer = setInterval(sample, sampleIntervalMs).unref();
  } catch {
    peak = NaN;
  }
  return {
    stop(): ResourceUsageSample | undefined {
      clearInterval(timer);
      try {
        const end = probe.cpuUsage();
        sample();
        const cpuMs = Math.max(0, Math.round((end.user - start.user + end.system - start.system) / 1000));
        return Number.isFinite(cpuMs) && Number.isFinite(peak) ? { cpuMs, peakRssBytes: Math.round(peak) } : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
