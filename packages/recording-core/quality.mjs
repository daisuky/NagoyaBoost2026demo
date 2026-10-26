// Require sustained degradation, rather than reacting to a single burst.
// This is a conservative heuristic, not a guarantee that TURN improves a path.
export function qualityWindow(previous, sample) {
  const next = { ...sample, bad: 0, loss: undefined };
  if (!previous || sample.at - previous.at < 1000 || sample.received < previous.received || sample.lost < previous.lost) return next;
  const received = sample.received - previous.received, lost = sample.lost - previous.lost;
  if (received + lost < 50) return next;
  next.loss = lost / (received + lost);
  next.bad = next.loss > 0.08 || sample.rtt > 0.5 ? (previous.bad || 0) + 1 : 0;
  return next;
}
