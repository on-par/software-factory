export interface ResourceUsageSample {
  cpuMs: number;
  peakRssBytes: number;
}

export interface ResourceProbe {
  cpuUsage(): { user: number; system: number };
  rss(): number;
}

export interface ResourceMeter {
  stop(): ResourceUsageSample | undefined;
}

const processProbe: ResourceProbe = {
  cpuUsage: () => process.cpuUsage(),
  rss: () => process.memoryUsage.rss(),
};

const noopMeter: ResourceMeter = { stop: () => undefined };

export function startResourceMeter(
  probe: ResourceProbe = processProbe,
  opts: { sampleIntervalMs?: number } = {},
): ResourceMeter {
  let startCpu: { user: number; system: number };
  let peak: number;
  try {
    startCpu = probe.cpuUsage();
    peak = probe.rss();
  } catch {
    return noopMeter;
  }
  let failed = false;
  const timer = setInterval(() => {
    try {
      peak = Math.max(peak, probe.rss());
    } catch {
      failed = true;
    }
  }, opts.sampleIntervalMs ?? 1000);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      try {
        const end = probe.cpuUsage();
        peak = Math.max(peak, probe.rss());
        if (failed) return undefined;
        const cpuMs = Math.max(0, Math.round((end.user - startCpu.user + end.system - startCpu.system) / 1000));
        const peakRssBytes = Math.round(peak);
        if (!Number.isFinite(cpuMs) || !Number.isFinite(peakRssBytes)) return undefined;
        return { cpuMs, peakRssBytes };
      } catch {
        return undefined;
      }
    },
  };
}
