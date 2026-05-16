# GT7 Telemetry Analyzer (GT7TA)

An open-source telemetry analyzer for **Gran Turismo 7** on PlayStation 5.
Captures the live UDP packet stream, decrypts it, and turns it into actionable
coaching: lap-time predictor, micro-sector heatmaps, ghost-lap overlays,
audio proximity warnings, and **hardware-anomaly detection** (e.g. brake pedal
not returning to zero).

> **Status:** working, single-user, runs locally on Windows (other OSes need
> minor tweaks). Not a polished product — a working analytical platform.

---

## What it does

- **Live HUD** at `http://localhost:9477/` showing speed, gear, RPM, throttle,
  brake, lap deltas, sector splits.
- **Live track map** with PB lap, last lap, and live car position. Overlay any
  saved "ghost" lap (your own PB or a captured world-record replay) and see
  the lateral deviation between racing lines.
- **Lap analyzer** with auto-derived 3-sector splits + theoretical-best.
- **Micro-sector heatmap** (10/30/60/100 slices) showing where time is lost
  vs PB. Two views:
  - **Cause** map: rising-edge detection — where time loss *starts*
    (closer to the actual driver mistake).
  - **Loss** map: where time loss *peaks* (downstream of the mistake).
- **Live "audio coach"** that fires aviation-style proximity warnings before
  recurring problem corners ("dark spots"). Bluetooth-speaker mode that
  pre-warms the audio path and fires earlier to compensate for BT latency.
- **Hardware-anomaly monitor**: detects brake-pedal-stuck events
  (brake + throttle pressed simultaneously beyond a normal trail-braking
  window). Live red banner + triple-pulse alert tone. Logs cumulative stuck
  duration per lap. *Originally built after diagnosing a sticky elastomer
  silently degrading laps for two days.*
- **Driver profiles**: switch between users so household members' laps don't
  mix.
- **Per-session rig-config versioning** (`rig-config.json`): every packet is
  tagged with the active hardware/setup version, so brake-pressure curves
  before/after an elastomer change are not silently averaged together.
- **Append-only JSONL recordings** under `recordings/` — full raw session
  archive, no vendor lock-in.
- **Top-500 cutoff tracker** (`/cutoff`): manual entry; shows your gap to
  any leaderboard cutoff alongside your live PB.
- **Prometheus exposition** at `/metrics` for Grafana dashboards (provisioned
  ones included).
- **Append-only event log** (`recordings/events-YYYY-MM-DD.jsonl`):
  `session_start`, `lap_end`, `pb_set` events.

> **A note on what was intentionally NOT included:** a development version
> of this codebase contained an integration with a third-party unofficial
> leaderboard service (GTSH-Rank). That integration is stripped from this
> public release out of respect for the service's TOS and the principle
> that telemetry tools should be built on data you have explicit permission
> to use. If you want similar functionality, integrate against an API that
> grants you access.

---

## How it works

The PlayStation 5 broadcasts a 296-byte encrypted UDP packet at 60 Hz on
port 33740 once it receives a heartbeat byte on port 33739. The packet is
encrypted with **Salsa20** using a known key and a per-packet nonce derived
from a magic constant XOR'd with a packet field.

This is community-known; this codebase implements:

1. UDP heartbeat → PS5
2. Salsa20 decryption (`salsa20.js`)
3. Packet parser (`parser.js`) — speed, RPM, gear, throttle, brake, fuel,
   tire temps, lap times, world position (X/Y/Z), suspension, etc.
4. Prometheus exporter (`metrics.js`) + JSONL recorder (`index.js`)
5. Lap analyzer + ghost overlay + audio coach (`lap-analyzer.js`,
   `lap-predictor.js`, `metrics.js`)

---

## Quick start (Windows)

### Prerequisites

- **Node.js ≥ 18**
- **Your PS5's LAN IP address** — required. Find it on the console under
  `Settings → Network → View Connection Status → IPv4 Address`.
  Tip: give the PS5 a static lease in your router so the IP never moves.
  Or, even cleaner, map a friendly hostname (e.g. `ps5.home.local`) to
  the IP in your `hosts` file or local DNS and pass the hostname instead.
- (Optional) Prometheus + Grafana for dashboards. Native binaries can live
  under `monitoring/native/` (gitignored — download separately from
  prometheus.io and grafana.com).

### Run

The `192.168.1.42` below is an example — **replace it with the IP (or
hostname) of YOUR PS5**, found in the console's Network settings.

```powershell
# Pass via flag:
node index.js --ps5 192.168.1.42      # ← replace with YOUR PS5's IP

# Or via env var:
$env:GT7_PS5_HOST = "192.168.1.42"    # ← same
node index.js

# Or with a friendly hostname (if you've mapped it in hosts/DNS):
node index.js --ps5 ps5.home.local
```

Open `http://localhost:9477/` to see the overview, then `/track`, `/laps`,
`/micro`, `/events`, `/cutoff`.

### Service controllers (Windows)

`services/start.cmd`, `services/stop.cmd`, `services/restart.cmd`,
`services/status.cmd` — port-based controllers for the exporter +
Prometheus + Grafana. Double-click in Explorer or call the underlying
`services/services.ps1 start|stop|status|restart` from a terminal.

---

## Endpoints

| URL | What |
|---|---|
| `/` | Overview + driver picker + cutoff banner |
| `/laps` | Today's laps with sector splits, theoretical best, variation stats |
| `/micro?n=30&mode=cause` | μ-sector heatmap (n=10/30/60/100, mode=cause/loss) |
| `/track?n=30&mode=cause` | Live SVG track map with ghost overlay + dark-spot circles |
| `/events` | Structured event log |
| `/cutoff` | Leaderboard cutoff tracker (manual entry) |
| `/metrics` | Prometheus text exposition |
| `/position.json` | High-frequency live position for audio-coach polling |
| `/laps.json`, `/micro.json` | Raw JSON for scripting |
| `POST /config` | Push a new rig-config version (writes `rig-config.json` + bumps `cfgV`) |

---

## Tools (`tools/`)

Standalone analyzers for one-off questions:

- `compare-to-pb.js` — generates a self-contained HTML report comparing your
  most recent lap to your PB (track map + speed/pedal traces).
- `laps-today.js` — table view of today's laps in the terminal.
- `s3-breakdown.js` — drill into Sector 3 specifically across recent laps.
- `ruined-laps.js` — find laps where the predicted-best was significantly
  faster than the actual lap (where mistakes ruined an "almost perfect" lap).
- `theoretical-best.js` — sum of fastest sector times from any lap.
- `set-ghost.js` — register any lap from any recording as the ghost-overlay
  reference for `/track`.
- `driver.js` — list/add/remove/use driver profiles.
- `find-wr.js`, `wr-corners.js` — scan recordings for fast laps and analyze
  brake zones.

---

## Competitive landscape

See [`docs/state-of-the-art-2026.md`](docs/state-of-the-art-2026.md) for a
detailed review of the GT7 telemetry ecosystem as of May 2026 — every
identifiable competing tool, feature matrix, market gaps, and where new
entrants can differentiate.

---

## Privacy

This project is designed to run **entirely on your local network**. No
telemetry leaves your machine in this public build.

Files containing personal data (driver names, ghost laps from other drivers,
actual recordings) are gitignored by default. If you fork and publish, run
a final scrub before pushing.

---

## Created by

This project was built together by a sim racer and an AI, over the stretch
of a long Friday night, while chasing the kind of lap time that sounds
impossible until the data tells you otherwise.

- **A human driver** who kept pushing, kept asking better questions, and
  refused to settle for "the brake just feels weird."
- **Claude** (Anthropic) — pair-programmer, debugger, data analyst, and
  occasional motivational coach.

We had fun building this. We hope it's useful to you.

If you race GT7, drive clean. If you build telemetry tools, build them
honestly. If you're an investor reading this looking for the next thing at
the intersection of motorsport and data — we'd love to talk.

---

## License

MIT — see `LICENSE`.

---

## Acknowledgments

- The community reverse-engineering of the GT7 UDP protocol (Bornhall, snipem,
  Nenkai/PDTools, gt-telem, et al.).
- Polyphony Digital for Gran Turismo 7.
