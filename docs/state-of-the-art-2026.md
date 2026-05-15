# GT7 Telemetry: State of the Art, May 2026

A competitive landscape review of the GT7 telemetry software ecosystem.

Date: 2026-05-12
Scope: every publicly identifiable GT7 telemetry tool still alive as of May 2026, with feature matrix, gaps, and implications for new entrants.

---

## 1. Executive Summary

- **The GT7 telemetry ecosystem has stratified into three clear tiers**: (1) free open-source dashboards (snipem/gt7dashboard, Bornhall, gt-telem, MoTeC bridges); (2) prosumer subscription analyzers (Coach Dave **Delta**, ~€4.99/mo or €49/yr, the only credible commercial AI-coaching product specifically supporting GT7); (3) mobile dashboards and race-engineer voice apps (Victory, GTRE, RS Dash ASR, SIM Dashboard, EzioDash, Racing Dashboard for GT7). The unbundling is real and the niches are tight.
- **AI coaching is now table stakes at the top of the market, but only Delta delivers it for GT7.** trophi.ai, the leading sim-racing AI coach product, **explicitly does not support GT7** (iRacing, ACC, F1 23/24/25, Le Mans Ultimate only). Delta has a structural moat on AI-coaching-for-GT7 specifically. New entrants like **GTCoach** (Oct 2025, free beta) and **GhostChaser** (iOS beta, early 2026) confirm the demand but neither is a mature product yet.
- **Nobody in the GT7 ecosystem does fleet/team race-engineer views, hardware-correlated analysis (FFB/elastomer/wheelbase variables), or investor-grade shareable reports.** Every public tool is built for the individual driver looking at their own laps. This is white space.
- **GT7TA's existing footprint is already deeper than ~80% of the field on data depth** (full Salsa20-decrypted UDP, 60Hz Prometheus pipeline, append-only JSONL archive, GTSH-Rank live integration, per-session config versioning). What it lacks is presentation polish, a shareable web report layer, and a coaching/insight layer.
- **The 2026 bar for a credible new entrant**: full-rate decrypted UDP capture, lap recording with PB diff, sector splits, theoretical-best, a mobile or web HUD, and at least a stub of automated insight ("you brake 8m too late at T3"). Anything less than that and you're behind the open-source baseline.

---

## 2. Landscape Overview

The matrix below covers every actively-maintained tool I could verify. "Active" = release or commit activity within the last ~12 months (since May 2025).

| Tool | Type | Platform | Distribution | Active in 2026? | Live HUD | Recording / Replay | Sector Splits | Ghost / PB Diff | AI / Auto Insight | Mobile | GTSH-Rank Integration | UDP Depth | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Coach Dave Delta** | Commercial SaaS | Win + Mac, with iOS companion | €4.99/mo, €49/yr, 7-day trial | Yes (v5.5, Apr 2026) | Yes | Yes (incl. from replays + leaderboard ghosts) | Yes | Yes (against top-pro ghosts) | **Yes — "Auto Insights" corner-by-corner AI coach** | iOS dash | No | Full | Only credible AI-coach product for GT7. |
| **SimHub** | Aggregator / Plugin | Windows | Free, donation | Yes | Yes (via dashboards) | Limited | Limited (depends on plugin) | Limited | No | Phone via custom dash | No | Full | The "Swiss army knife" — feeds wind sims, motion rigs, shakers, USB devices. Plugin-driven; community-built GT7 dashes. |
| **snipem/gt7dashboard** | Open source | Win / Linux / Mac (Python, Bokeh) | Free (GPL-3.0) | Yes (v1.2.4, Feb 2026; ~295 stars) | Yes | Yes | Implicit (via line analysis) | Yes (vs ref lap) | No | No | No | Full | The de-facto OSS baseline. Time-diff graph, race-line view, speed peaks/valleys, fuel-map tool. |
| **Victory: Race Engineer for GT7** | Commercial mobile | iOS, Android, Web | Freemium, in-app purchases | Yes (last update Mar 16, 2026) | Yes | Yes (auto-records sessions) | Yes | Limited | Heuristic feedback (throttle, trail-brake, tire mgmt) | **Native** | No | Mid-high | AI race-engineer voice with 6 named personalities, multilingual. 4.74-star rating, 690+ reviews. |
| **GTRE (Gran Turismo Race Engineer)** by skepller | Commercial mobile | Android (Play Store), PSVR2 | Freemium | Yes | Yes (audio) | No | No | No | Voice callouts only | Native | No | Mid | Auto-finds PS via mDNS. Reads lap, delta, fuel, position. Limited because GT7 hides gap/wear/weather externally. |
| **RS Dash ASR** | Commercial mobile/desktop | iOS, Android, Windows | Freemium (Pocket Playground) | Yes | Yes | Yes (Advanced Analysis high-res data tool) | Yes | Yes | No | Native | No | Full | Multi-sim. The most "professional dash" looking of the mobile set. Customisable widget editor. |
| **SIM Dashboard** (Stryder-IT) | Commercial mobile | iOS, Android | Free + one-time PRO IAP | Yes | Yes | Limited | No | No | No | Native | No | Mid | 200+ widgets. One-time pay. Generic across many sims, GT7 is one config. |
| **EzioDash** | Indie iOS | iOS | DonationWare | Status uncertain; original Swedish dev (granturismosport.se) | Yes | No | No | No | No | iOS only | No | Low-mid | Simple HUD. Hobby project. No data analysis layer. |
| **Racing Dashboard for GT7** | Indie iOS | iOS | Free (id1661444023) | Uncertain — last reviewed entries from 2024 | Yes | No | No | No | No | iOS only | No | Low | Tach, speed, fuel, tire temps, TCS state. Display-only. |
| **GTCoach** (gtcoach.app) | Indie beta | Windows / Mac | Free beta | Beta since Oct 2025; status uncertain | Audio cues | No | Implicit | Yes (vs top weekly ghosts) | **Yes — audio coaching pre-corner + post-corner suggestions** | No | No | Full | Single-developer project. Limited to current weekly races, ghosts refreshed Mondays. |
| **GhostChaser** | Indie beta | iOS / iPadOS | Free beta (early 2026) | Beta | Yes | Yes (reference lap loaded from leaderboard) | Yes | **Strong: input-level delta (brake/throttle), audio braking tones** | Coaching tones, not LLM | iOS native | No | Mid-full | Differentiated by *input-level* ghost comparison, not just position delta. Beta as of ~Apr 2026. |
| **Zero-Core** | OSS hobby | Android (Termux + Python) | Free (script) | New (announced ~Apr 2026 on GTPlanet) | Yes (terminal) | Yes (JSONL/CSV) | No | No | No | Android only | No | Mid | Phone-only HUD, no PC. Notable because it eliminates the "PC on same LAN" requirement. |
| **MoTeC i2 + sim-to-motec / GT7toMoTeC** | Conversion pipe | Windows | Free | Yes (forked actively, last release 2025) | No | Yes (i2 format) | Yes (in MoTeC) | Yes (in MoTeC) | No | No | No | Full | Pro-level offline analysis. Required for engineers who already know i2. Steep learning curve. |
| **gt-telem (RaceCrewAI)** | OSS Python lib | Any | Free (MIT) | Yes | No (library) | Yes (raw) | N/A | N/A | N/A | No | No | Full | Building-block for other tools. Covers GT Sport, GT6, GT7. |
| **Bornhall/gt7telemetry** | OSS Python script | Any | Free | Stale-ish (the foundational fork) | Terminal | Dump | No | No | No | No | No | Full | The original community reverse-engineering work. Most projects descended from this. |
| **MacManley/gt7-udp** | OSS firmware | ESP32 / ESP8266 | Free | Active | Embedded HUD | No | No | No | No | Hardware | No | Mid | Microcontroller-grade — for physical button-box / dash hardware. |
| **gt7coder/grandturismo-srs-proxy** | OSS proxy | Win/Mac/Linux | Free | Active | No | Forward only | No | No | No | No | No | Pass-through | Bridges GT7 telemetry → Sim Racing Studio for wind/shakers/motion. |
| **Telemetria GT7 / Race Dash / "Racing Dashboard"** | Various indie | Web / mobile | Free + ads | Mixed status | Yes | No | No | No | No | Varies | No | Low-mid | Localized / regional dashboard variants. Mostly display-only. |

**Tools mentioned in the brief that I could NOT verify exist in May 2026:**
- **GTLook** — no current site, no Google footprint. Likely defunct or never existed under that name.
- **HUDsight** — appears to be a non-GT7 product (it's a generic game-overlay tool); no GT7 plugin I could find.
- **GTI Pro** / **"GT Telemetry" mobile** — couldn't disambiguate; likely conflated with "Racing Dashboard for GT7" or Victory.
- **Tony Whitley / gt7-pdtelemetry** — no longer surfaces. May have been deprecated and absorbed by gt-telem or Bornhall's repo.
- **Daniel Pinheiro / dapibo** — no GT7-specific tool surfaces under that name in 2026.
- **praiano63** — alive and active, but he's a **tuning sheet author** (Patreon at €X/mo, 520+ car setting sheets), not a telemetry tool. Out of scope.

Some of those tools may have existed earlier and been retired without notice; some may have been rebranded. I am flagging the uncertainty rather than padding the matrix.

---

## 3. Per-Tool Deep Dives

### 3.1 Coach Dave Delta — the commercial benchmark

- **URL**: https://coachdaveacademy.com/gran-turismo-7/
- **Platform**: Windows / Mac desktop, with iOS companion. PC must be on same LAN as PS5.
- **Distribution**: Subscription. €4.99/month or €49/year. 7-day trial.
- **Status**: Aggressively maintained. Delta 5.5 launched April 2026 with Video Analysis. GT7 support went live in late 2024 / 2025. Cross-sim product (also covers iRacing, ACC, AC Evo, Le Mans Ultimate, F1).
- **Core features**:
  - Live telemetry HUD (throttle, brake, steering, gears, speed, fuel, sector and lap times) — works from time trial, online race, offline, **and from replays of other people's laps loaded from the leaderboard**.
  - Lap comparison against ghosts of named GT World Finalists (TSUTSU, ManuRodry, Tidgney, Igor Fraga).
  - **Auto Insights AI coaching** — corner-by-corner breakdown into braking / entry / apex / exit phases. Plain-language guidance ("brake later", "earlier throttle"). Bundled in subscription.
  - Tyre pressures and temperatures (which GT7 doesn't show natively).
  - Video Analysis (5.5) — sync video with telemetry.
  - Setup-sharing layer (the Coach Dave setup business is the parent product).
- **Data depth**: Full UDP parsing including the new 1.42 "B"/"~" packets (sway/heave/surge, unfiltered throttle/brake).
- **UX quality**: Professional. Polished UI, branded, screenshots look like a fintech dashboard rather than a community tool.
- **Notable gaps**: No multi-driver / team view; no GTSH-Rank integration; subscription required to access analysis (free tier is thin); LAN setup required (PC on same network as console); no public, shareable post-session report (the data lives inside the app).
- **Strategic note**: Delta is the only product GT7TA will be directly compared to by a serious investor. The pricing benchmark for "credible subscription" in this ecosystem is €5/mo / €49/yr.

### 3.2 SimHub — the integration plane

- **URL**: https://www.simhubdash.com/community-2/simhub/gt7-in-simhub/
- **Platform**: Windows.
- **Distribution**: Free, donation-supported. Closed source but widely trusted.
- **Status**: The dominant cross-sim aggregator since 2017. GT7 plugin maintained.
- **Core features**: Reads GT7 UDP on ports 33740/33741 given PS5 IP, exposes telemetry to ~hundreds of community-built dashboards, hardware (USB shakers, wind, motion rigs, Arduino devices), and external apps. The GT7 Dashboard for SimHub (Overtake.gg) is the most popular GT7-specific layout.
- **Data depth**: Full UDP.
- **Strength**: Hardware integration is unmatched. If a sim racer owns a motion rig, they almost certainly own SimHub.
- **Notable gaps**: Not an analysis tool — it's a pipeline. No native AI coaching, no investor-grade reports, no PB analysis beyond what plugins add. Custom overlays cannot be drawn onto the GT7 game window (PS5 closed platform); must be on a second screen.
- **Strategic note**: GT7TA's positioning vs SimHub is "we are an analysis product, SimHub is a transport". Co-existence is feasible; the PS5 only emits one UDP stream, so the user must choose, but proxies (GT7Proxy, mentioned on xsimulator forums) split the stream.

### 3.3 snipem/gt7dashboard — the OSS reference implementation

- **URL**: https://github.com/snipem/gt7dashboard
- **Platform**: Python + Bokeh; Windows, macOS, Linux; Docker images.
- **Distribution**: Free, GPL-3.0.
- **Status**: Last release v1.2.4 on 25 Feb 2026. **~295 stars, 59 forks** as of my fetch — by far the most adopted OSS GT7 dashboard.
- **Core features**: Time-diff graph between last and reference lap; race-line map with throttle/brake/coast color overlay; speed/distance and speed-variance graphs; tables of speed peaks and valleys; fuel-map optimization. Lap recording and reference-lap comparison.
- **Data depth**: Full UDP. Originally forked from Bornhall.
- **UX quality**: Hobbyist-grade. Bokeh charts. Functional, not polished. Web UI in a browser.
- **Notable gaps**: No AI coaching, no GTSH-Rank, no mobile, no multi-driver view, no shareable HTML report. Setup requires Docker or Python knowledge — not consumer-ready.
- **Strategic note**: **This is GT7TA's closest architectural competitor.** Same fundamental idea (Python-ish backend, web UI, ref lap comparison). GT7TA differentiates on: GTSH-Rank, JSONL archive, Prometheus/Grafana stack, hardware-aware config, native Windows binaries, standalone HTML SVG report.

### 3.4 Victory: Race Engineer for GT7 — the polished mobile entrant

- **URL**: https://apps.apple.com/us/app/victory-race-engineer-for-gt7/id6752813246 ; https://play.google.com/store/apps/details?id=io.podium.app
- **Developer**: LJ Softworks / Podium.
- **Platform**: iOS, Android, web.
- **Distribution**: Freemium.
- **Status**: Last update 16 Mar 2026. 4.74 stars from 690+ ratings.
- **Core features**: Live HUD; AI race-engineer voice with 6 named personalities (Vinnie/NY, Sgt. Briggs/Drill, Clint/Texas, Hiro/JP, Sophia/FR, Victoria/CA); multilingual (JP/FR/EN); braking & acceleration traces; tire grip / temperature; fuel laps remaining; auto session recording; corner-by-corner heuristic feedback on throttle, trail-brake, tire mgmt, fuel.
- **Data depth**: Mid-to-high. Reads the modern packet set.
- **UX quality**: Polished consumer mobile UX. Best-in-class for the "want a virtual race engineer in my ear" use case.
- **Notable gaps**: No deep offline analysis; no GTSH-Rank; no integration with hardware config; coaching is heuristic, not generative-AI / LLM-level. No team/fleet view.

### 3.5 trophi.ai — the AI-coach leader that **explicitly does not cover GT7**

- **URL**: https://www.trophi.ai/
- **Platform**: Desktop overlay, voice + visual.
- **Distribution**: Subscription (Premium / Premium+Setups / Professional tiers).
- **Status**: Active and well-funded. Mansell AI voice coach, in-game overlays, post-session corner-by-corner debrief.
- **Supported sims**: iRacing (Road), ACC, F1 23/24/25, Le Mans Ultimate.
- **Why it matters even though it doesn't do GT7**: It defines what "AI sim coaching" looks like in 2026 for the rest of the industry. Sim Racing Cockpit's review claims "found 2 seconds a lap". The bar trophi.ai sets is: in-game overlay + live voice + corner-by-corner debrief + setup recommendations. **GT7 is the sim it does not cover** — that's the gap Delta exploits and that GT7TA could exploit.

### 3.6 GTCoach (gtcoach.app) — the indie AI-coach challenger

- **URL**: https://gtcoach.app (announced on GTPlanet thread 433585, Oct 2025).
- **Platform**: Windows / Mac.
- **Distribution**: Free public beta.
- **Status**: Single-developer beta as of late 2025; current status uncertain.
- **Core features**: Real-time audio coaching cues *before* each corner with braking points; post-corner suggestions covering brake point, throttle application, apex speed; reference laps from top drivers in the **current weekly online races only**, refreshed Mondays.
- **Strategic note**: Confirms the "real-time AI coaching for GT7" itch is being scratched by indies. Direct functional overlap with where GT7TA could go. Currently scoped narrowly (weekly races only).

### 3.7 GhostChaser — input-delta against leaderboard ghosts

- **Platform**: iOS / iPadOS.
- **Distribution**: Free beta, ~Apr 2026.
- **Core features**: Loads a ghost lap from leaderboard, compares your **inputs** (brake, throttle) against the ghost's inputs in real time. Audio coaching tones play the reference's braking pattern through headphones; countdown beeps before braking zones. Corner-by-corner speed deltas + gear indicators.
- **Why it's interesting**: Most "ghost lap" tools show *position* delta (you're 0.3s behind). GhostChaser is one of the few that surfaces *input* delta (the ghost brakes at this pressure, you brake at this pressure) — which is closer to actionable coaching.

### 3.8 GTRE (skepller.dev/gtre) — focused race-engineer voice

- **URL**: https://skepller.dev/gtre/
- **Platform**: Android Play Store + PSVR2 native.
- **Distribution**: Freemium.
- **Core features**: Auto-discovers PS5 on network; reads lap times, delta-from-best, current/remaining laps, position, fuel, fuel estimation, tire temps, crash checkups; realistic radio-effect voice; customisable callout presets; PSVR2-aware (overlays in headset).
- **Acknowledged limits** (from the developer): GT7 doesn't externally expose gap-to-other-cars, tire wear, weather, or penalties — so GTRE explicitly can't deliver those callouts. This is a **platform constraint** that affects every entrant in the category, including GT7TA.

### 3.9 RS Dash ASR — the multi-sim prosumer mobile dash

- **URL**: https://www.rsdash.com/rs-dash-gt7
- **Vendor**: Pocket Playground.
- **Platform**: iOS, Android, Windows (Microsoft Store).
- **Distribution**: Freemium.
- **Core features**: Real-time RPM/speed/gear/throttle/brake; live timing and lap charts; **Advanced Analysis** high-res data analysis tool; dashboard editor.
- **Strength**: Looks more professional than EzioDash or Racing Dashboard. The desktop Advanced Analysis tool is the only mobile-derived solution that has serious post-session analysis ambitions.

### 3.10 SIM Dashboard (Stryder-IT)

- **URL**: https://www.stryder-it.de/simdashboard/
- **Platform**: iOS, Android.
- **Distribution**: Free + one-time PRO IAP (no subscription).
- **Core features**: 200+ widgets; tachometers, steering displays, timing screens; throttle/brake input, tire wear, RPM, speed, boost, shift points; community design gallery for GT7-specific layouts.
- **Notable**: One of the few products in this list that's a one-time purchase. Generic across many sims — GT7 is one of dozens.

### 3.11 MoTeC i2 pipeline (sim-to-motec / GT7toMoTeC)

- **URLs**: https://github.com/GeekyDeaks/sim-to-motec ; https://github.com/cybercic/GT7toMoTeC
- **Platform**: Windows + MoTeC i2 Pro (free download from MoTeC).
- **Distribution**: OSS.
- **What it does**: Captures GT7 UDP and writes MoTeC's `.ld` log format. Auto-detects car and track. New file per session change (lap number resets).
- **Why it matters**: This is the **pro / motorsport-engineer pipeline**. If a GT7TA user has a motorsport background, they will already know MoTeC i2 and may not want a new analyzer — they'll want a pipe into i2.
- **Weakness**: Steep learning curve. MoTeC is real engineering software, not a consumer product.

### 3.12 Honourable mentions

- **gt-telem** (RaceCrewAI): clean Python lib, building block for downstream tools.
- **MacManley/gt7-udp**: ESP32/ESP8266 firmware — for people building physical button boxes / dash hardware.
- **Zero-Core**: phone-only Termux script. Notable for *removing the PC requirement*.
- **Bornhall/gt7telemetry**: the foundational reverse-engineering work that everything else descends from.

---

## 4. Feature Taxonomy: Table Stakes vs Differentiators

### Table stakes in May 2026 (every credible tool does these)

1. **Full Salsa20 UDP decryption** including the 1.42 "B"/"~" packets (sway/heave/surge, unfiltered throttle/brake).
2. **Real-time HUD** showing speed / RPM / gear / throttle / brake / fuel / lap / sector.
3. **Lap recording** with at least best-lap retention.
4. **PB / reference-lap comparison** with a time-delta visualization.
5. **Sector splits**, either explicit or implicit via reference-lap distance mapping.
6. **Tire temps** (since GT7 doesn't show them natively, every serious tool surfaces them).
7. **Some form of automated insight** — even Victory's heuristic callouts count. Pure display-only tools (Racing Dashboard for GT7, EzioDash) are now considered "lite".

### Soft differentiators (some tools have, some don't)

8. **AI coaching with corner-by-corner phase breakdown** (Delta, GTCoach, partially Victory).
9. **Voice race-engineer callouts** (Victory, GTRE, open-source GPT-4o experiments).
10. **Top-pro ghost comparison** loaded from leaderboard (Delta, GhostChaser, GTCoach for weekly races).
11. **Input-level (not just position) delta** (GhostChaser, partially Delta).
12. **MoTeC i2 export** (only the OSS converters).
13. **Hardware-side outputs** — motion, wind, shakers (SimHub, srs-proxy).
14. **Theoretical-best lap** (snipem, RS Dash ASR Advanced Analysis, Delta).

### Hard differentiators (where GT7TA can stand out)

15. **GTSH-Rank live integration** — XOR-decrypted live DR / SR / leaderboard rank in the same dashboard as telemetry. **Nobody else does this publicly.**
16. **Per-session config versioning** — brake-pressure curves, FFB settings, elastomer hardware config tracked alongside the lap data so deltas can be attributed to setup, not driver. **Nobody else does this.**
17. **Append-only JSONL session archive** — the user owns the raw data forever, not the vendor. Most commercial tools lock data inside their cloud. This is a fintech-style positioning lever.
18. **Native Windows binaries for the metrics stack (Prom + Grafana)** — no Docker. Pragmatic for sim racers whose machines don't run Docker reliably.
19. **Standalone HTML PB-comparison report** — a shareable artifact (SVG track map + speed/pedal traces) that doesn't require the viewer to install anything. **The closest analogue in this list is nothing.** Delta keeps data inside Delta; snipem requires you to run Bokeh; everyone else is in-app.

---

## 5. Gaps and White Space

These are the things **nobody in the public GT7 ecosystem does well, or at all**.

### 5.1 Multi-driver fleet / team views (race engineer dashboard)
Every product in the matrix is built for one driver looking at their own data. **There is no GT7 product positioned as the "race engineer cockpit"** where one engineer watches 2–8 drivers in a league or team simultaneously, comparing their inputs across the same lap. Sim racing leagues exist (GT World Series, GTSH-Rank-tracked leagues, hundreds of community leagues) — they have no engineer-side product.

### 5.2 Cross-session pattern analysis ("the tired-driver mode")
Nobody surfaces patterns *across* sessions:
- "Your apex speed at Big Willow T3 drops 4 km/h after lap 12 of a session — fatigue threshold."
- "You're 0.3s slower on average between 5pm and 7pm local time on Tuesdays."
- "Your sector-2 consistency is 8x worse on the lap immediately after a near-miss."

Delta's Auto Insights is per-corner, per-lap. Nothing in this market does longitudinal / behavioural analytics. GT7TA already archives the raw JSONL — the data substrate is there.

### 5.3 Hardware-correlated analysis
Every tool treats the driver as a black box producing pedal/wheel inputs. **Nobody correlates input behavior to hardware configuration changes.** Examples no one does:
- Did swapping the brake elastomer from yellow→red change my peak brake pressure distribution?
- After moving the pedal plate forward 30mm, did my trail-braking duration shift?
- Did increasing FFB Max Torque from 8 to 10 change my mid-corner steering smoothness?
GT7TA's `rig-config.json` and per-session config versioning is the only architecture in the field that could even ask these questions.

### 5.4 Investor-grade / shareable polished views
There is no Stripe-quality, screenshot-able post-session report in the GT7 ecosystem. Delta's reports are in-app. snipem's are Bokeh charts. Victory's are mobile screenshots. **A polished, public-URL, link-to-share post-session debrief is white space.** This is also the most investor-relevant gap, because shareable artifacts = network effects = LTV story.

### 5.5 Lap-stitching simulation with realistic delta
Everyone computes "theoretical best = sum of best sectors". Nobody computes the **realistic theoretical best** that accounts for the fact that sector-1's exit speed constrains sector-2's entry speed. A physics-aware lap stitcher ("if you could only carry over the entry speed you actually had, your realistic best is 1:32.4, not the theoretical 1:31.8") is novel.

### 5.6 Stewards-grade race incident reproduction
GT7's penalty system is famously opaque. There is no public tool that lets you replay a contact incident frame-by-frame from telemetry, with both cars overlaid, brake/steer inputs visible, to make a stewards-style argument. League organizers want this. GT7's UDP packet does include positional data — the lift is non-trivial because you only see your own car's stream, but synchronized session-recording from both drivers' clients would solve it.

### 5.7 GTSH-Rank-integrated analytics
GTSH-Rank is the de-facto unofficial leaderboard. **Only GT7TA decrypts and integrates it.** White space includes:
- Predicting end-of-week rank given current points and historical opponent activity.
- Surfacing "who can overtake you on points this week".
- Combining DR points + telemetry quality ("you have B-rank DR but your input smoothness is A-rank — you're a contact magnet, not slow").

### 5.8 Live AI coaching that responds to *your* driving in real time
Delta's Auto Insights is post-lap. GTCoach is corner-cue based. trophi.ai (which is real-time) explicitly excludes GT7. **A real-time LLM-grade GT7 coach does not exist.** A 60Hz telemetry pipeline is the substrate; the missing piece is a small model fast enough to run inference at sub-200ms.

### 5.9 Setup correlation with driver result
Delta sells setups. Coach Dave's setup business is the parent. But nobody correlates *driver outcomes* with setup choice for the daily races — "drivers running this LSD setting average 0.4s/lap faster but 2x DNF rate". This is the moneyball / quant angle.

### 5.10 Tournament-style cohort analytics
Daily Race B / C drivers are de-facto a tournament cohort. Nobody offers cohort analytics — your distribution of lap times vs the cohort, your improvement trajectory vs cohort, your "alpha" relative to peers of equal DR. This is a near-perfect fintech-language framing.

---

## 6. State of the Art in 2026

**The minimum bar a credible new entrant must clear:**
1. Full UDP decrypt + 60Hz capture.
2. Live HUD.
3. Lap recording with PB and reference-lap diff.
4. Sector splits + theoretical best.
5. At least heuristic insight ("your brake pressure peaked late") — pure display-only is no longer credible.
6. Either a mobile HUD or a polished web HUD. Terminal-only is OSS-tier.

**Where the frontier sits:**
- **AI coaching** is the contested frontier. Delta dominates the GT7-specific commercial slot. trophi.ai dominates the multi-sim slot but excludes GT7. Indies (GTCoach, GhostChaser) are circling. The first product to ship a **real-time, in-ear, LLM-grade GT7 coach** wins the next 12 months of mindshare.
- **Voice race engineer** is largely solved as a category — Victory and GTRE both ship credible products. Voice alone is no longer enough to differentiate.
- **Hardware integration** is solved by SimHub. Nobody is going to outcompete SimHub on motion-rig / shaker integration. Don't try.
- **MoTeC i2 export** is solved for the motorsport-engineer crowd. Niche.
- **Mobile dash** is saturated (Victory, RS Dash, SIM Dashboard, EzioDash, Racing Dashboard, GhostChaser). Hard to enter.
- **Web-based, shareable, polished post-session reports** are an open frontier with zero strong incumbents.
- **Fleet / engineer / team views** are an unclaimed frontier.
- **Setup-correlated and hardware-correlated analytics** are an unclaimed frontier.

**The structural constraint nobody can break around:** GT7's UDP packet is single-player. Gap-to-rival, tire wear, weather, penalties, and other cars' inputs are not externally exposed by the game. Every player in this market hits this wall. GTRE's developer flagged this explicitly. Any pitch that promises to deliver these features is technically dishonest unless it adds out-of-band sources (replay parsing, leaderboard scraping, screen OCR).

---

## 7. Implications for GT7TA's MVP and Roadmap

### 7.1 What GT7TA already has that beats the market

Mapping GT7TA's existing features against the matrix:

- Full Salsa20-decrypted UDP at 60Hz: **on par with Delta and snipem, ahead of every mobile product**.
- Prom + Grafana stack: **unique** (everyone else uses in-app charts).
- Append-only JSONL: **unique** (data ownership story).
- Live lap-time predictor (XZ nearest-neighbor against PB): **on par with Delta**.
- Sector tracking from PB trace: **table stakes**.
- Theoretical-best lap: **table stakes**.
- PB-comparison HTML with SVG track map: **on par with Delta's lap report, ahead of all OSS**.
- GTSH-Rank live integration: **unique. Nobody else does this.**
- Native Windows binaries for Prom + Grafana: **unique** (and pragmatically necessary).
- Hardware-aware config (elastomers, RS50, FFB): **unique architecture; the only product positioned to do hardware-correlated analysis**.
- Per-session config versioning: **unique**.

Net: GT7TA is already at or above the table-stakes line, with several unique architectural advantages.

### 7.2 What GT7TA lacks vs the market

- **No mobile HUD.** Victory, RS Dash, GTRE, GhostChaser all have this. GT7TA's web UI in a desktop browser is acceptable for a phase-1 demo but not for a consumer product.
- **No AI / auto-insight layer.** Delta has it, GTCoach has a stub, trophi.ai sets the bar. GT7TA has the raw 60Hz substrate but no analysis layer over it yet.
- **No voice race-engineer.** Easy and well-trodden — Victory and GTRE both ship credible versions.
- **No shareable public-URL post-session report.** The local HTML report is the seed; needs to become a hosted artifact.
- **No video sync.** Delta 5.5 has it.
- **No cross-driver / team view.** Nobody has it — see white space.

### 7.3 Recommended MVP positioning

For a new entrant in the GT7 telemetry space, **lean into the analytics / data-ownership angle**, not the consumer-app angle. Three positioning bullets:

1. **"Treats your sessions as an append-only audit log."** Data ownership, no vendor lock-in.
2. **"Correlates hardware configuration with driver outcomes."** Per-session `rig-config.json` is the seed. Show a chart of "lap time vs elastomer config" from real session data — nobody else does this.
3. **"Native leaderboard-rank integration."** GTSH-Rank decryption is unique. Show live DR delta as you race.

### 7.4 MVP feature priorities (sequence)

For an initial release:
- **P0**: Stability of the 60Hz capture + lap recording pipeline. Defensive, not new features.
- **P0**: Polish the standalone HTML PB report — this is the shareable artifact investors will look at. Make it screenshot-quality.
- **P1**: Add a single auto-insight stub per lap ("you carried 4 km/h less through T3 vs PB; brake released 12m earlier") — even a heuristic is enough to claim the category.
- **P1**: GTSH-Rank delta widget in the live web UI — visible during the actual demo race.
- **P2**: Mobile-friendly version of the live HUD page (responsive CSS on the existing web UI). Don't build a native iOS app yet.

For 2026 H2 / 2027 frontier:
- **AI coaching layer**: a small model running inference at 60Hz on the JSONL stream, surfacing post-lap corner-by-corner deltas vs your own PB and vs the GTSH-Rank top-N ghosts. This is the move that closes the gap with Delta.
- **Hardware-correlated analysis**: A/B reports across `rig-config.json` versions. "Your runs on red+yellow elastomers had median brake pressure 8% higher than brown+yellow runs." Genuinely novel.
- **Fleet / engineer view**: multi-driver session overlay. A league-engineer product. Different ICP, expansion ramp.
- **Public sharable session URLs**: hosted post-session debrief pages — the "Stripe receipt" of telemetry. Network effects + LTV story.
- **Cohort analytics**: where you sit in the DR-band distribution. Pure quant framing.

### 7.5 What NOT to build

- A motion / wind / shaker integration. SimHub owns this.
- A MoTeC i2 export pipeline. sim-to-motec / GT7toMoTeC already exist.
- A generic mobile dash to compete with Victory or RS Dash. Saturated category.
- A voice race-engineer that competes with Victory or GTRE on personality / multilingual flavor. The category is solved.
- Anything that promises gap-to-rival, tire wear, weather, or penalty data without an out-of-band source. The UDP packet doesn't have it.

---

## Sources

- [Best Apps for Gran Turismo 7 — Coach Dave Academy](https://coachdaveacademy.com/tutorials/best-apps-for-gran-turismo-7/)
- [Delta for Gran Turismo 7 — GT7 AI Coaching & Data Logger](https://coachdaveacademy.com/gran-turismo-7/)
- [Delta 5.5 — Setups, Telemetry & Video Analysis](https://coachdaveacademy.com/delta/)
- [How to Use Auto Insights AI Coaching in Delta](https://coachdaveacademy.com/documentation/how-to-use-auto-insights-ai-coaching-in-delta/)
- [Overview of GT7 Telemetry Software — GTPlanet thread](https://www.gtplanet.net/forum/threads/overview-of-gt7-telemetry-software.418011/)
- [Gran Turismo 7 Telemetry Data Now Available via Open-Source Software — GTPlanet](https://www.gtplanet.net/gran-turismo-7-telemetry-data-now-available-via-open-source-software/)
- [Zero-Core: Phone-Only GT7 Telemetry HUD on Android — GTPlanet](https://www.gtplanet.net/forum/threads/zero-core-phone-only-gt7-telemetry-hud-on-android-no-pc-no-simhub.434916/)
- [I wish we had real time coaching in GT7, so I'm building it — GTPlanet (GTCoach)](https://www.gtplanet.net/forum/threads/i-wish-we-had-real-time-coaching-in-gt7-so-i%E2%80%99m-building-it.433585/)
- [Looking for 50 GT7 players to beta test a real-time lap coaching app (iOS) — GTPlanet (GhostChaser)](https://www.gtplanet.net/forum/threads/looking-for-50-gt7-players-to-beta-test-a-real-time-lap-coaching-app-ios.437214/)
- [OpenSource AI Race Engineer for Gran Turismo 7 — GTPlanet](https://www.gtplanet.net/forum/threads/opensource-ai-race-engineer-for-gran-turismo-7.431931/)
- [GT7 Race Engineers — GTPlanet](https://www.gtplanet.net/forum/threads/gt7-race-engineers.435733/)
- [GT7 In SimHub](https://www.simhubdash.com/community-2/simhub/gt7-in-simhub/)
- [GT7 Dashboard for SimHub — OverTake.gg](https://www.overtake.gg/downloads/gt7-dashboard-for-simhub.81006/)
- [snipem/gt7dashboard — GitHub](https://github.com/snipem/gt7dashboard)
- [Bornhall/gt7telemetry — GitHub](https://github.com/Bornhall/gt7telemetry)
- [RaceCrewAI/gt-telem — GitHub](https://github.com/RaceCrewAI/gt-telem)
- [GeekyDeaks/sim-to-motec — GitHub](https://github.com/GeekyDeaks/sim-to-motec)
- [cybercic/GT7toMoTeC — GitHub](https://github.com/cybercic/GT7toMoTeC)
- [MacManley/gt7-udp (ESP32/ESP8266) — GitHub](https://github.com/MacManley/gt7-udp)
- [gt7coder/grandturismo-srs-proxy — GitHub](https://github.com/gt7coder/grandturismo-srs-proxy)
- [snipem/go-gt7-telemetry — GitHub](https://github.com/snipem/go-gt7-telemetry)
- [Victory: Race Engineer for GT7 — App Store](https://apps.apple.com/us/app/victory-race-engineer-for-gt7/id6752813246)
- [Victory: Race Engineer for GT7 — Google Play](https://play.google.com/store/apps/details?id=io.podium.app)
- [Gran Turismo Race Engineer (GTRE) — skepller.dev](https://skepller.dev/gtre/)
- [RS Dash — Pocket Playground](https://www.rsdash.com/rs-dash-gt7)
- [RS Dash ASR — Microsoft Store](https://apps.microsoft.com/detail/9p49h1h9nb2g)
- [SIM Dashboard — Stryder-IT](https://www.stryder-it.de/simdashboard/)
- [SIM Dashboard PRO upgrade docs](http://www.stryder-it.de/simdashboard/help/en/SIM_Dashboard_App/PRO_Upgrade/Unlock_Features_(PRO_Upgrade))
- [EzioDash — granturismosport.se](https://granturismosport.se/eziodash/)
- [Racing Dashboard for GT7 — App Store](https://apps.apple.com/us/app/racing-dashboard-for-gt7/id1661444023)
- [trophi.ai (sim racing coach)](https://www.trophi.ai/sim-racing-coaching)
- [trophi.ai pricing](https://www.trophi.ai/pricing-sim-racing)
- [Telemetry in Gran Turismo 7 — How to Use It & Find More Pace — DG Edge](https://www.dg-edge.com/articles/guides/telemetry-in-gran-turismo-7-how-to-use-it-find-more-pace/544)
- [Using MoTeC Telemetry in Gran Turismo 7 — DG Edge](https://www.dg-edge.com/articles/guides-equipment/using-motec-telemetry-in-gran-turismo-7/354)
- [The app that can monitor GT7 time trial telemetry — Traxion](https://traxion.gg/the-app-that-can-monitor-gran-turismo-7-time-trial-telemetry-tyre-pressures-and-racing-lines/)
- [Praiano's Tunes — Patreon (out of scope, tuning sheets)](https://www.patreon.com/cw/praianogtsettings)
- [Sony AI — Gran Turismo Sophy global release](https://ai.sony/articles/sonyai022/)
