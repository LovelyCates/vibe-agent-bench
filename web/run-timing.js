const checkPhases = new Set(['prepare', 'implement', 'verify']);
const activeStatuses = new Set(['queued', 'preparing', 'running']);
const terminalStatuses = new Set(['pass', 'fail', 'error', 'blocked', 'skipped', 'interrupted', 'completed']);
const checkActivity = new Set(['command', 'command-output']);
const agentActivity = new Set(['step', 'tool', 'message', 'error']);

export function checkRunPhase(id, index, agentIndex, phasesByCheck) {
  const phase = phasesByCheck?.get(id);
  if (checkPhases.has(phase)) return phase;
  if (id === 'workspace' || (agentIndex >= 0 && index < agentIndex)) return 'prepare';
  return id === 'agent' || id === 'skill' ? 'implement' : 'verify';
}

function timestamp(value) {
  const time = typeof value === 'string' ? Date.parse(value) : value;
  return Number.isFinite(time) ? time : null;
}

function duration(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function latest(...times) {
  const time = Math.max(...times.filter((value) => value !== null));
  return Number.isFinite(time) ? time : null;
}

function orderedEnd(start, end) {
  return start !== null && end !== null && end >= start ? end : null;
}

function newEvidence() {
  return { start: null, end: null, durationMs: null, activity: null, terminal: false };
}

function recordBoundary(evidence, status, at, elapsed) {
  if (status === 'running') {
    evidence.start ??= at;
  } else if (terminalStatuses.has(status)) {
    evidence.terminal = true;
    // A later report may attach artifacts without changing the check's original finish.
    evidence.end ??= at;
    evidence.durationMs ??= duration(elapsed);
  }
}

function measureCheck(check, evidence, clock) {
  const savedStart = timestamp(check.startedAt);
  const savedEnd = timestamp(check.finishedAt);
  const observedEnd = evidence?.end ?? null;
  const durationMs = duration(check.durationMs) ?? evidence?.durationMs ?? null;
  const start = savedStart
    ?? (savedEnd !== null && durationMs !== null ? savedEnd - durationMs : evidence?.start)
    ?? (observedEnd !== null && durationMs !== null ? observedEnd - durationMs : null);
  if (start === null) return null;

  const end = orderedEnd(start, savedEnd)
    ?? (durationMs !== null ? start + durationMs : orderedEnd(start, observedEnd));
  if (end !== null) return { start, end, live: false, partial: false };

  const activity = evidence?.activity ?? null;
  const running = check.status === 'running' || (evidence?.start != null && !terminalStatuses.has(check.status));
  if (clock !== null && running && !evidence?.terminal && savedEnd === null) {
    return { start, end: latest(start, activity, clock), live: true, partial: false };
  }
  // Recovery can block a check without writing a finish for it. Only show the observed portion.
  return { start, end: activity !== null && activity > start ? activity : null, live: false, partial: true };
}

function addSpan(spans, phase, span) {
  if (!span) return;
  const previous = spans.get(phase);
  if (!previous) {
    spans.set(phase, span);
    return;
  }
  const start = Math.min(previous.start, span.start);
  const end = latest(previous.end, span.end, previous.start, span.start);
  spans.set(phase, {
    start,
    end: end > start || previous.end !== null || span.end !== null ? end : null,
    live: previous.live || span.live,
    partial: previous.partial || span.partial,
  });
}

export function createRunTiming() {
  const checkEvents = new Map();
  let review = newEvidence();

  function reset() {
    checkEvents.clear();
    review = newEvidence();
  }

  function record(entry, phase) {
    const at = timestamp(entry.at);
    if (phase === 'review' && entry.kind === 'phase' && entry.phase === 'advice') {
      recordBoundary(review, entry.status, at);
      return;
    }
    if (!checkPhases.has(phase)) return;
    const id = entry.checkId ?? (phase === 'implement' && agentActivity.has(entry.kind) ? 'agent' : undefined);
    if (!id) return;
    const evidence = checkEvents.get(id) ?? { ...newEvidence(), phase };
    if (entry.kind === 'check') recordBoundary(evidence, entry.status, at, entry.durationMs);
    else if (checkActivity.has(entry.kind) || agentActivity.has(entry.kind)) evidence.activity = latest(evidence.activity, at);
    else return;
    checkEvents.set(id, evidence);
  }

  function measure(run, phasesByCheck, now = Date.now()) {
    const spans = new Map();
    if (!run) return { durationMs: null, origin: null, phases: spans };
    const created = timestamp(run.createdAt);
    const started = timestamp(run.startedAt);
    const finished = timestamp(run.finishedAt);
    const clock = activeStatuses.has(run.status) ? timestamp(now) : null;

    if (created !== null) {
      const end = orderedEnd(created, started);
      const live = end === null && run.status === 'queued' && clock !== null;
      addSpan(spans, 'queue', {
        start: created, end: live ? Math.max(created, clock) : end, live, partial: end === null && !live,
      });
    }

    const checks = run.checks ?? [];
    const seen = new Set();
    const agentIndex = checks.findIndex(({ id }) => id === 'agent');
    checks.forEach((check, index) => {
      seen.add(check.id);
      const phase = checkRunPhase(check.id, index, agentIndex, phasesByCheck);
      addSpan(spans, phase, measureCheck(check, checkEvents.get(check.id), clock));
    });
    for (const [id, evidence] of checkEvents) {
      if (!seen.has(id)) addSpan(spans, evidence.phase, measureCheck({}, evidence, clock));
    }
    if (review.start !== null) {
      addSpan(spans, 'review', measureCheck({ status: run.advice?.status }, review, clock));
    }

    const measured = [...spans.values()];
    const firstObserved = measured.length ? Math.min(...measured.map((span) => span.start)) : null;
    const origin = created ?? started ?? firstObserved;
    const end = clock === null ? orderedEnd(origin, finished)
      : latest(origin, clock, ...measured.map((span) => span.end ?? span.start));
    const phases = new Map();
    for (const [phase, span] of spans) {
      phases.set(phase, {
        offsetMs: Math.max(0, span.start - origin),
        durationMs: span.end === null ? null : span.end - span.start,
        live: span.live,
        partial: span.partial,
      });
    }
    return { durationMs: origin === null || end === null ? null : end - origin, origin, phases };
  }

  return { reset, record, measure };
}
