// Tiny Server-Sent Events broker.
//
// One topic per SSE channel. Each subscribed browser holds an open HTTP
// response; the broker writes "data: <json>\n\n" frames to them as packets
// arrive. No external deps, no protocol upgrade — just HTTP keep-alive.
//
// Used by the 60Hz streaming HUD at /hud60. Browser opens an EventSource
// against /hud60/stream; this broker feeds it every parsed UDP packet.

const subscribers = new Map(); // topic -> Set<res>
let broadcastCount = 0;

function subscribe(topic, res) {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  const set = subscribers.get(topic);
  set.add(res);
  res.on('close', () => { set.delete(res); });
  res.on('error', () => { set.delete(res); });
}

function broadcast(topic, payload) {
  const set = subscribers.get(topic);
  if (!set || set.size === 0) return;
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const frame = 'data: ' + data + '\n\n';
  broadcastCount++;
  for (const res of set) {
    try { res.write(frame); } catch { /* the close handler will clean up */ }
  }
}

function subscriberCount(topic) {
  const set = subscribers.get(topic);
  return set ? set.size : 0;
}

function totalSubscribers() {
  let n = 0;
  for (const set of subscribers.values()) n += set.size;
  return n;
}

function stats() {
  return { broadcastCount, totalSubscribers: totalSubscribers() };
}

module.exports = { subscribe, broadcast, subscriberCount, stats };
