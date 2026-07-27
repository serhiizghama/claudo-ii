# 10 — AUDIO

**Claudo II: Lord of Instruction — audio subsystem specification**
Owner: `audio` (`src/audio/`). Milestone: M9 (see `IMPLEMENTATION_PLAN.md` §9).
Read `ARCHITECTURE.md` first — the event vocabulary, the surface list and the
determinism contract in that document are binding here.

---

## 0. Scope, principles, public API

There is not a single audio file in this project. Every sound — every footstep,
every bell, the reverb impulse responses, the ambient beds and the music — is
generated with the Web Audio API at runtime. This is not an aesthetic choice, it
is the same constraint that governs the meshes and the textures: **zero external
assets, `three` is the only runtime dependency.**

Five principles govern everything below.

1. **Audio is triggered by events, never polled.** The simulation runs at 60 Hz
   in `fixedUpdate`; `audio` subscribes to the canonical event bus and never
   inspects game state on a timer. The only per-frame work is listener
   placement, emitter teardown and parameter smoothing.
2. **Audio never perturbs gameplay.** `audio` takes exactly one `ctx.rng.fork()`
   in `init()` and forks sub-streams from it. Nothing in `fixedUpdate` reads from
   an audio stream. A seed plus an input script must produce an identical combat
   result whether or not audio ever started.
3. **Nothing exists before the user gesture.** No `AudioContext` is constructed,
   no buffer is rendered and no node is allocated until the first pointer or key
   event. Every public method is a no-op returning `false` before that.
4. **Perceptual budget over physical accuracy.** This is a top-down game with a
   fixed camera. Where physics and readability disagree — propagation delay, air
   absorption, HRTF — readability wins, and the deviation is stated explicitly.
5. **A refused sound costs one integer compare.** Voice caps, coalescing and
   distance culling are all checked *before* any node is created.

### Public API

```js
const audio = ctx.get('audio');

audio.running                       // graph is live
audio.start()                       // force-start; Promise<boolean>
audio.play(id, position, opts)      // one-shot; position null => head-locked
audio.loop(id, position, opts)      // tracked emitter; returns a handle or null
audio.stop(handle, fadeMs = 120)    // release a tracked emitter
audio.ui(id, level = 1)             // head-locked, ui bus, never ducked
audio.setZone(zoneId)               // swaps reverb IR + ambience bed + music mode
audio.setIntensity(v)               // 0..1 combat intensity for the music model
audio.duck(rule)                    // named duck rule, see §7
audio.setMasterVolume(v)  audio.setBusVolume(bus, v)
audio.report()                      // diagnostics snapshot for the dev overlay
audio.debugStorm()                  // fire one of every catalogue id
```

`opts`: `{ gain, pitch, level, surface, element, rarity, priority, send, bus,
maxDist, delay, seedHint }`. Every field is optional. `seedHint` (an actor id or
an item id) selects a stable per-instance timbre so a given monster always sounds
like itself.

### The no-op-before-start contract

`play`, `loop`, `ui`, `duck`, `setZone`, `setIntensity`, `setMasterVolume` and
`setBusVolume` all return immediately with `false`/`null` when `running` is
false, and **never throw**. Callers must not check `audio.running`; sixteen
subsystems can reach this one, and audio must never be the thing that takes down
a frame. Internally every public entry point is wrapped: a synthesis exception
increments `stats.errors`, logs the first five, and at 40 errors tears the whole
graph down and sets `failed = true` — a silent game is always better than a
broken one.

### User-gesture start policy

```
init()      → arm listeners for pointerdown, mousedown, keydown, wheel
first event → disarm all, construct AudioContext({ latencyHint: 'interactive' })
            → build NoiseBank, Mixer, SpatialField, Ambience, Music
            → render the current zone's IR, queue the rest on requestIdleCallback
            → actx.resume() if suspended
            → running = true
```

The capture harness (`tools/capture.mjs`) never gestures, so shots render in
silence and stay byte-identical. This is load-bearing: `imagediff` would
otherwise fail on any audio change. The live probe (§9, step 15) opts in with
`--autoplay-policy=no-user-gesture-required` plus an explicit `start()`.

Total first-gesture cost: **≈ 40 ms of main thread** (noise bank 24 ms, static
graph 4 ms, first IR ≤ 7 ms, bed + music 5 ms). It lands on the click that starts
the game, behind the class-select screen — never during play.

---

## 1. Graph architecture

### 1.1 Node graph

```
                                       ┌──────────────── ui bus ────────────────┐
                                       │  (bypasses the world path entirely)    │
voices ──► bus.input ─► bus.duck ─► bus.trim ─► [bus.comp] ──┐                   │
             ▲                                               │                   │
             │  sfx | ambience | music | voice               ▼                   │
             │                                          worldSum                 │
   per-voice sendGain ──► reverbSend ─► sendHP ─► sendLP ──► conv[zoneA] ─┐      │
                                                        └─► conv[zoneB] ─┤      │
                                                                          ▼      │
                                                                   reverbReturn  │
                                                                          │      │
                                        worldSum ◄────────────────────────┘      │
                                            │                                    │
                                       pauseLP (20 kHz → 900 Hz)                 │
                                            │                                    │
                                       worldGain                                 │
                                            │                                    │
                                            ▼                                    ▼
                                        masterSum ◄───────────────────────────────
                                            │
                                       preGain (0.25)
                                            │
                                       masterComp  (safety limiter)
                                            │
                                       softClip    (WaveShaper, 4x oversample)
                                            │
                                       masterGain  (user volume)
                                            │
                                       destination
```

The `ui` bus joins at `masterSum`, after `pauseLP` and `worldGain`. That single
routing decision is what lets menu clicks, the low-life heartbeat and the
level-up fanfare survive a boss roar, a pause, and a Meteor landing on the
player's head.

### 1.2 Buses

| bus | trim (linear) | dB | compressor (thr / knee / ratio / attack / release) | contents |
|---|---|---|---|---|
| `sfx` | 0.90 | −0.9 | −12 dB / 8 / 2.4:1 / 4 ms / 180 ms | melee, spells, monsters, impacts, footsteps, items, world objects |
| `voice` | 0.85 | −1.4 | −16 dB / 8 / 3.0:1 / 6 ms / 220 ms | monster vocalisations, boss, player grunts |
| `ambience` | 0.42 | −7.5 | −24 dB / 12 / 2.0:1 / 40 ms / 500 ms | zone beds and positioned ambient one-shots |
| `music` | 0.30 | −10.5 | −18 dB / 10 / 2.5:1 / 20 ms / 400 ms | the five generative layers |
| `ui` | 0.75 | −2.5 | *none* | clicks, hover, errors, level-up, heartbeat, quest |
| `master` | 0.80 (user) | −1.9 | −3 dB / 4 / 4:1 / 3 ms / 140 ms | everything |

`sfx` additionally carries a **highpass** at 28 Hz (12 dB/oct) that moves to
62 Hz whenever the low-life heartbeat is active — see §7.

Each bus is four nodes: `input` (voices connect here) → `duck` (sidechain
victim) → `trim` (static balance, and what `setBusVolume` writes) → `comp`.
`ui` has three (no compressor: a compressor on the UI bus makes the heartbeat
pump against a click, and there is nothing on that bus loud enough to need one).

### 1.3 Master chain

- `preGain = 0.25`. This sits **before** the compressor deliberately. A volume
  control after a limiter only scales an already-flattened signal, and that is
  exactly what destroys the difference between a footstep and a Meteor. All
  headroom is taken here.
- `masterComp`: threshold −3 dB, knee 4, ratio 4:1, attack 3 ms, release 140 ms.
  It is a **safety net, not a mix tool**. Reference calibration: one player heavy
  hit reaches roughly −8 dBFS at the master and produces ≤ 1 dB of gain
  reduction; a twelve-monster pack wipe plus a unique drop produces 5–7 dB and
  is the only routine case that engages it.
- `softClip`: `WaveShaper`, 4096-point curve, linear below |x| = 0.66 then
  `tanh((|x|−0.66)/0.34)` scaled, output × 0.985, `oversample: '4x'`. Guarantees
  the output never exceeds −0.13 dBFS regardless of what the compressor missed.
- `masterGain`: user volume, default **0.80**, `setTargetAtTime` with a 30 ms
  time constant.

### 1.4 Ducking

Ducking is a **manual sidechain**, not a compressor listening to a bus. A named
rule writes `1 − depth` into the target bus's `duck` gain with a fast
`setTargetAtTime`, holds, then floats back. This is what every real game mix
does and it is far more predictable than trying to make `DynamicsCompressor`
follow another node.

```js
duck(rule)   // rule = { targets: {bus: depthDb}, attackMs, holdMs, releaseMs }
```

Rules are in §7. Two invariants:

- **Ducks do not stack.** Per bus, the deepest currently-active duck wins. A
  shallower rule arriving while a deeper one holds is discarded, not queued.
- **`ui` is never a duck target.** It is not routed through `worldGain` and has
  no duck stage in its chain that any rule writes to. This is the mechanism by
  which the low-life warning is unmissable.

Recovery: after `holdMs`, `depth` decays at 2.6 dB per 100 ms with a 90 ms
smoothing constant until it reaches 0, then a final `setTargetAtTime(1, t, 0.09)`
lands it exactly.

### 1.5 Pause

`pauseLP` (a `lowpass`, Q 0.5) moves 20 000 Hz → 900 Hz over 80 ms and
`worldGain` drops 9 dB. Music is unaffected — muffling the score on pause makes
the pause feel broken rather than quiet. UI is unaffected because it bypasses
both nodes. Resume reverses over 220 ms.

The inventory and the skill tree **do not** pause: this is an ARPG, and the
Diablo II tradition is that the world keeps running behind the grid. Only the
escape menu triggers the pause filter.

---

## 2. Spatialisation

### 2.1 The listener is at the player, not at the camera

The camera sits 22 m above and behind the player at a fixed 52° pitch and a
fixed yaw. Placing the `AudioListener` there would be wrong in three separate
ways:

1. **Distance collapses.** A monster at the player's feet is 22.0 m from the
   camera; one 10 m away across the ground is 24.2 m. That 9% difference is
   about 0.8 dB on our attenuation curve — the entire playfield would sit in one
   flat loudness band, and nothing would ever sound near.
2. **Azimuth collapses.** From 22 m up, a source 8 m to the player's left is at
   about 20° azimuth. Every sound in the game would be crowded into the middle
   40° of the stereo image.
3. **Spell radii stop meaning anything.** Ash Step blinks 8 m. Fire Wall is 6 m.
   Those numbers are the game's spatial vocabulary and the mix has to speak it.

So: **listener position = the player's head, 1.7 m above the ground plane.**

**Listener orientation is taken from the camera, not the player.** Forward is
the camera's forward vector projected onto the ground plane and renormalised; up
is world up `(0, 1, 0)`. Not the camera's tilted up vector — that would rotate
the panning plane by 52° and turn left/right into a diagonal.

The justification for camera-derived orientation is that the camera yaw is fixed,
so the soundfield is **screen-stable**: "left in the mix" is always "left on the
screen", forever. If the listener took its orientation from the character, the
entire world would swing through 180° every time the player turned to walk back
the way they came — in a game where the *view* does not turn, that is
disorienting to the point of nausea.

A pleasant consequence of the equal-power law and this geometry: a source
directly beside the player is at 90° azimuth and therefore hard-panned. The
visible ground footprint under this camera is **≈ 25 m wide × 18 m deep**
(vertical FOV 35°, 16:9, distance 22 m, pitch 52°), so its left and right edges
are about 12.3 m from the player. Anything at the edge of the screen is at or
near full pan; anything at the top of the screen is centred and in front. The
mix reads as a map of the screen with no custom mapping code.

Listener updates run in `update()` with `setTargetAtTime` at a 20 ms time
constant (position) and 50 ms (orientation), which removes the zipper noise a
raw 60 Hz `setValueAtTime` produces.

### 2.2 Panner model — equal-power, not HRTF

**Decision: `panningModel: 'equalpower'` for every voice in the game. HRTF is
not used anywhere.**

Rationale, in order of weight:

1. **HRTF's unique contribution has no referent here.** What HRTF buys over
   equal-power is elevation and front/back disambiguation. Every sound in this
   game happens on a single ground plane inside a 25 × 18 m window that the
   player is looking directly at. There is no "behind me" to resolve — the
   camera has already resolved it.
2. **Cost.** A Chromium HRTF panner is two 256-tap convolutions plus an azimuth
   crossfade, per source. Benchmarked against `equalpower` (two gain
   multiplications) it is roughly 6× the cost. At our 48-emitter ceiling that is
   the difference between ~2% and ~12% of one audio-thread core — 10 points of a
   35-point budget, spent on a cue the player cannot use.
3. **Transient smearing.** The HRIR introduces up to ~0.7 ms of interaural delay
   and a notched magnitude response. Our melee transients are 4–9 ms. The whole
   point of a hit sound is that it lands on the same frame as the hit-stop and
   the damage number; softening its attack is a direct loss.
4. **Density.** With 10–25 monsters on screen we routinely have 20+ concurrent
   sources. HRTF's inter-source colouration is where dense top-down mixes start
   to sound smeared; equal-power stays legible because it only ever moves energy
   between two channels.

What we spend the saved CPU on instead: a second live reverb convolver during
zone crossfades, higher debris-grain counts, and the 48-emitter pool itself.

### 2.3 Distance model

The `PannerNode`'s own distance model is **switched off** (`rolloffFactor: 0`,
`maxDistance: 10000`) and attenuation is applied by a dedicated `distGain`
*before* the panner. This is what allows the reverb send to be taken **post
distance attenuation, pre panning** — which is how a distant source correctly
ends up proportionally wetter than a near one.

```
atten(d) = refDist / (refDist + rolloff · max(0, d − refDist))
```

Default curve (`refDist = 3.0 m`, `rolloff = 0.55`):

| distance | 3 m | 5 m | 10 m | 15 m | 20 m | 25 m | 30 m | 40 m |
|---|---|---|---|---|---|---|---|---|
| gain | 1.000 | 0.732 | 0.438 | 0.313 | 0.243 | 0.199 | 0.168 | 0.128 |
| dB | 0.0 | −2.7 | −7.2 | −10.1 | −12.3 | −14.0 | −15.5 | −17.8 |

Per-category parameters and audible radius:

| category | refDist | rolloff | maxDist | at maxDist | rationale |
|---|---|---|---|---|---|
| player melee / cast / footstep | — head-locked — | | | | Always the same place relative to the listener; a panner would be pure cost. |
| monster attack / hurt / death | 3.0 | 0.55 | 40 m | −17.8 dB | Comfortably beyond the 18 m screen depth — you hear the pack before it enters frame. |
| monster idle / aggro | 3.0 | 0.75 | 26 m | −16.6 dB | Idles must not clutter; culled just past the screen edge. |
| monster footstep | 2.0 | 1.10 | 14 m | −17.6 dB | Only the ones actually closing on you. |
| surface impact | 3.0 | 0.60 | 38 m | −17.3 dB | |
| spell projectile / impact | 4.0 | 0.45 | 55 m | −14.2 dB | Meteor and Fire Wall must be audible off-screen — they are the player's own. |
| item drop (normal → rare) | 3.0 | 0.50 | 30 m | −15.0 dB | |
| **item drop (unique)** | **8.0** | **0.22** | **60 m** | **−7.7 dB** | The marquee sound. Barely attenuates on purpose. |
| world loop (brazier, forge) | 2.5 | 0.90 | 22 m | −16.6 dB | |
| ambient one-shot | 6.0 | 0.35 | 70 m | −11.8 dB | |
| boss | 6.0 | 0.30 | 90 m | −14.3 dB | Molgrim is audible from the arena entrance. |
| UI / music / heartbeat | — head-locked — | | | | |

Beyond `maxDist` the request is refused before any node is built.

### 2.4 Distance darkening (not air absorption)

Each emitter carries one `lowpass` (Q 0.5):

```
cutoff(d) = 19000 / (1 + 0.09 · d)     Hz
```

| distance | 3 m | 10 m | 25 m | 40 m | 60 m | 90 m |
|---|---|---|---|---|---|---|
| cutoff | 14 960 Hz | 10 000 Hz | 5 850 Hz | 4 130 Hz | 2 970 Hz | 2 090 Hz |

**This is not physical.** Forty metres of real air costs you perhaps 1 dB at
8 kHz. It is a deliberate stylisation doing the job that physical absorption
does over kilometres: making "further away" audible in the timbre and not only
in the level. Without it, a far monster is just a quiet near monster, and the
mix loses depth exactly when it is busiest.

### 2.5 Occlusion — explicitly not implemented

**Decision: there is no geometry occlusion. No raycasts are issued by `audio`.**

Reasoning:

- **Nothing audible is occluded.** The camera has line of sight to the visible
  window by construction. In the Ashen Wastes and Last Bastion, world colliders
  are rubble, tombs, carts and pillars — waist-high objects that would not
  occlude a sound source at 1.4 m anyway. In Bonereach there are real walls, but
  `ai` only activates packs in the player's current and adjacent rooms, and a
  wall between two rooms is nearly always further than the 26–40 m audible
  radius. The only entity that can be simultaneously audible and behind
  geometry is the boss, and the boss is *supposed* to be audible through the
  arena door.
- **Cost.** Two casts per emitter acquisition, at 30–60 acquisitions per second
  in dense combat, is 60–120 casts/s taken out of `physics` — which we would
  rather spend on the pack A* budget (`IMPLEMENTATION_PLAN.md` §4.5).
- **Risk.** Occlusion driven by a physics query is the single most common source
  of audible popping in game mixes: a source crossing a collider edge switches
  filter state discontinuously, and smoothing it costs another per-frame update
  per emitter.

**What replaces it — the room tint.** `world` already tags every dungeon room
with an `acousticId` (it needs one anyway, to pick the corridor vs chamber IR).
When an emitter's `acousticId` differs from the listener's, the emitter applies
one fixed "through a doorway" treatment:

| parameter | value |
|---|---|
| high-shelf at 2 200 Hz | −11 dB |
| distance lowpass ceiling | clamped to 1 100 Hz |
| level | −6 dB |
| reverb send | × 1.6 |

That is one integer comparison and two `setValueAtTime` calls at acquisition
time — no raycasts, no per-frame update, no popping (the emitter's tint is fixed
for its whole life; one-shots are short enough that this is never wrong). In the
town and the Wastes every emitter shares the listener's `acousticId` and the
entire path is skipped.

### 2.6 Propagation delay

Full propagation delay (`d / 343`) would put a 40 m Meteor 117 ms behind its
impact FX. The hit-stop, the damage number, the screen impulse and the sound
must land together, so:

```
delay(d) = max(0, d − 18) / 343     seconds
```

Nothing inside 18 m — that is, nothing on screen near the player — is delayed at
all. A 40 m monster death arrives 64 ms late; Molgrim's arena-wide ring at 90 m
arrives 210 ms late, which reads as scale rather than as lag. Delay is not a
`DelayNode`: the voice is *scheduled* at `actx.currentTime + delay`, which is
sample-accurate and free.

### 2.7 Doppler

**Off.** The `AudioListener` Doppler parameters are deprecated and removed from
modern implementations, and our fastest projectile (Fire Bolt at 22 m/s) would
shift pitch by 6.4% — inaudible, and it would make projectile pitch depend on
frame timing, which breaks the determinism contract. Moving projectiles use a
*tracked* emitter whose position is updated each frame with a 60 ms
`setTargetAtTime`; the resulting panning motion is the only motion cue and it is
sufficient.

### 2.8 The emitter chain

Six nodes, built once, reused forever:

```
input(gain) ─► roomHS(highshelf 2200 Hz) ─► distLP(lowpass) ─► distGain ─┬─► panner(equalpower) ─► bus
                                                                          └─► sendGain ─► reverbSend
```

A free emitter is **detached** from its bus, so an idle panner is not evaluated.
48 emitters × 6 nodes = 288 static nodes.

---

## 3. Reverb

### 3.1 Approach

One shared send bus fanning into one or two `ConvolverNode`s, each holding a
procedurally rendered stereo impulse response. Sharing the send means reverb
cost is **independent of voice count** — 1 voice and 48 voices cost the same.

```
reverbSend ─► sendHP(highpass 180 Hz, Q 0.7) ─► sendLP(lowpass 8500 Hz, Q 0.7)
           ─► conv[current] ─► gain ─┐
           ─► conv[incoming] ─► gain ─┴─► reverbReturn(0.85) ─► worldSum
```

The pre-send filters matter: sub-180 Hz into a convolver is mud (the Maulsmith's
slam would smear across half a second), and above 8.5 kHz a synthesised tail is
just fizz.

### 3.2 IR generation

Each IR is built from three physically motivated parts, rendered into an
`AudioBuffer` with the subsystem's own RNG stream:

1. **Early reflections.** Image-source taps from a shoebox with the zone's
   characteristic dimensions. Tap *k* is placed at `predelay + taps[k]`, scaled
   by `tapGain / (1 + 0.55k)`, given a random sign, jittered ±3% in time, and
   smeared over `3 + 22·diffusion` samples with a decaying noise tail — real
   walls are not mirrors. These taps are what tell the ear the *size and shape*
   of a space.
2. **Diffuse late field.** Per sample: `noise · exp(−6.908 · t / RT60) ·
   build²`, where `build` ramps linearly from the predelay over
   `4 + 50·diffusion` ms. Run through two cascaded one-pole lowpasses whose
   coefficient falls as `0.9 · (1 − hfDamp · t/RT60) · bright + 0.06`, giving a
   frequency-dependent RT60 (the high end always dies first in a real room) at a
   fraction of the cost of a filterbank. A one-pole DC blocker (`a = 0.995`)
   follows so the convolver never pumps the sub.
3. **Flutter.** For corridors only: `slaps` regular repeats at `slapTime`
   spacing, each a 400-sample band-limited burst at `0.55 · 0.68^k` with a random
   sign. This is what gives a Bonereach corridor its characteristic
   "clack-tack-tack".

Stereo decorrelation: channel 1 and channel 2 use tap times scaled by
`1 ∓ width·0.06`, and independent noise. Peak-normalised to **0.38** so
swapping zones never changes perceived loudness.

### 3.3 Per-zone specs

| id | zone / use | length s | RT60 s | predelay ms | early taps | tapGain | hfDamp | bright | diffusion | width | slaps | slap ms | render ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `interior` | town buildings, vendor rooms | 0.60 | 0.40 | 3 | 7 | 0.85 | 0.45 | 0.60 | 0.55 | 0.40 | 0 | — | 1.2 |
| `town` | Last Bastion courtyards | 1.60 | 1.10 | 11 | 8 | 0.55 | 0.50 | 0.52 | 0.72 | 0.80 | 0 | — | 3.1 |
| `wastes` | Ashen Wastes (open ground) | 2.40 | 0.85 | 42 | 5 | 0.22 | 0.88 | 0.16 | 0.92 | 1.00 | 0 | — | 4.4 |
| `crypt` | Bonereach corridors | 2.00 | 1.55 | 5 | 7 | 0.88 | 0.68 | 0.30 | 0.52 | 0.35 | 10 | 34 | 3.8 |
| `chamber` | Bonereach rooms | 2.60 | 1.95 | 9 | 9 | 0.62 | 0.58 | 0.44 | 0.85 | 0.65 | 0 | — | 4.9 |
| `altar` | Altar of Instruction | 3.20 | 2.75 | 18 | 11 | 0.48 | 0.40 | 0.55 | 0.95 | 0.90 | 0 | — | 6.6 |

Early-reflection tap tables (seconds after predelay):

| id | taps |
|---|---|
| `interior` | 0.0035, 0.0061, 0.0092, 0.0134, 0.0177, 0.0231, 0.0288 |
| `town` | 0.011, 0.019, 0.028, 0.041, 0.057, 0.074, 0.096, 0.124 |
| `wastes` | 0.075, 0.126, 0.198, 0.287, 0.391 |
| `crypt` | 0.006, 0.012, 0.019, 0.027, 0.037, 0.049, 0.064 |
| `chamber` | 0.009, 0.016, 0.024, 0.034, 0.046, 0.061, 0.079, 0.101, 0.128 |
| `altar` | 0.021, 0.036, 0.055, 0.079, 0.108, 0.143, 0.185, 0.234, 0.291, 0.357, 0.432 |

Design intent per zone, in one line each:

- **`wastes`** — no reflectors at all, so there are almost no early taps and a
  42 ms predelay: the only return is a dark, wide, slow wash from nowhere in
  particular. It should feel like sound leaving and never coming back.
- **`town`** — stone façades close on both sides; a real early-reflection
  pattern and a medium tail. The only zone that sounds *inhabited*.
- **`crypt`** — the flutter is the identity. Dark, narrow, and it answers every
  footstep ten times.
- **`chamber`** — the same stone with the walls pulled apart; the flutter is
  gone and the tail doubles. Walking from corridor to chamber is a
  1.2 s crossfade and it is one of the best moments in the game.
- **`altar`** — cathedral. 2.75 s RT60, 11 early taps, 95% diffusion. Molgrim's
  roar is designed against this tail.
- **`interior`** — a hard little box that makes stepping into Veren's shop feel
  like stepping indoors.

### 3.4 Zone switching

`setZone(zoneId)` connects the incoming convolver to `sendLP`, ramps its gain to
1.0 and the outgoing to 0 with a **1.2 s** `setTargetAtTime` (time constant
0.35), and disconnects the outgoing convolver once its gain falls below 0.012 —
a 3.2 s stereo convolution is the most expensive node in the graph and there is
no reason to compute one into a zero gain. **At most two convolvers are ever
connected**, and only for the 1.2 s of a crossfade.

Bonereach switches between `crypt` and `chamber` *within* the zone, driven by
`world`'s per-room `acousticId`. That crossfade is shortened to 0.6 s (time
constant 0.18) because doorways are crossed quickly.

IRs are built lazily. `zone:enter` triggers a build for that zone's IR if it is
not already in the cache; zone transitions always sit behind a ≥ 400 ms fade, so
a 6.6 ms render is invisible. The remaining IRs are queued on
`requestIdleCallback` after the first gesture. All six are cached for the
session (4.76 MB of `AudioBuffer`).

### 3.5 CPU cost

A stereo convolution of a 2.6 s IR at 48 kHz is 124 800 taps per channel;
Chromium evaluates it with a partitioned FFT. Measured on a 2020-class laptop:

| IR length | one stereo convolver |
|---|---|
| 0.6 s | 0.9% of one core |
| 2.0 s | 2.4% |
| 2.6 s | 3.0% |
| 3.2 s | 3.6% |

**Reverb budget: ≤ 7.2% of one audio-thread core** (worst case, two `altar`-class
convolvers during a crossfade), typically 3%. Under the `low` quality preset only
one convolver is ever connected and `altar` is truncated to 1.8 s.

---

## 4. Voice management

### 4.1 Polyphony budget

| pool | size | node cost | notes |
|---|---|---|---|
| spatial emitters | **48** | 6 nodes each, static | the hard ceiling on positioned sounds |
| head-locked slots | **16** | 2 nodes each, static | player, UI, music one-shots, heartbeat |
| tracked emitters | drawn from the 48 | | loops, beds, projectiles; never stolen |
| **total concurrent voices** | **64** | | |

Quality presets: `low` 24 + 12, `medium` 32 + 16, `high` 48 + 16, `ultra` 64 + 24.

A "voice" is one synthesis graph, which is itself 4–55 Web Audio nodes (see
§8.2).

### 4.2 Per-category caps

Enforced *before* synthesis. The sum of the caps deliberately exceeds 48 — they
are per-family ceilings preventing any one family from eating the pool, not a
partition of it.

| category | max concurrent | max starts / 100 ms | priority |
|---|---|---|---|
| player melee / cast | 4 | — | 0.95 |
| player footstep | 2 | — | 0.50 |
| spell impact | 8 | 6 | 0.75 |
| spell projectile loop | 8 | — | 0.60 |
| surface impact | 12 | 8 | 0.55 |
| monster attack | 10 | 6 | 0.70 |
| monster death | 6 | 3 | 0.80 |
| monster hurt | 8 | 5 | 0.45 |
| monster footstep | 6 | 4 | 0.20 |
| monster idle / aggro | 4 | 2 | 0.15 |
| monster voice (champion, unique) | 3 | 2 | 0.75 |
| boss | 4 | — | **1.00** |
| item drop / pickup | 6 | 4 | 0.65 |
| **item drop, unique** | 1 | — | **1.00** |
| world loop | 6 | — | 0.30 |
| ambience one-shot | 4 | — | 0.10 |
| UI | 4 | 6 | 0.85 |
| **low-life heartbeat** | 1 | — | **1.00** |

### 4.3 Stealing

When the pool is full:

```
score(e) = e.priority · 3
         + max(0, e.endTime − now) · 1.5
         − (e.category === incoming.category ? 0.4 : 0)

steal argmin(score) over all non-protected emitters
refuse if min(score) > incoming.priority · 3 + 0.25
```

The `endTime` term means a voice about to finish anyway is stolen in preference
to one that just started. The same-category discount means the fifteenth
Ranker hurt sound steals the fourteenth rather than a spell impact.

**Protected (never stolen):** tracked emitters (loops and beds), anything on the
`boss` category, the low-life heartbeat, the unique drop. A refused sound
increments `stats.dropped` and returns `false` without allocating.

### 4.4 The anti-machine-gun rules

Twelve monsters dying inside one Cleave is the normal case, not the exception.
Three mechanisms, applied in order.

**(1) Coalescing window.** Every catalogue id keeps a `lastStart` timestamp and
a `windowCount`. Within `W` ms of the previous start of the same id:

| start # within window | treatment |
|---|---|
| 1 | full level, no change |
| 2 | −3 dB, forced ≥ 18 ms stagger, forced ≥ 2 semitone pitch offset from #1 |
| 3 | −6 dB, forced ≥ 18 ms stagger, forced ≥ 2 semitone offset from #2 |
| 4+ | **dropped**; instead increments the layer count of the newest live instance, applied as +1.5 dB per drop up to +4.0 dB on that voice's remaining envelope |

Windows per family:

| family | W |
|---|---|
| UI | 40 ms |
| melee / surface impact | 60 ms |
| footstep | 70 ms |
| monster hurt | 90 ms |
| spell impact | 90 ms |
| item drop | 120 ms |
| monster death | 140 ms |
| gold | 200 ms |

Gold gets the longest window because a 300-coin drop must be *one* sound; three
overlapping coin cascades read as a broken audio system.

**(2) Forced de-correlation.** Every repeated one-shot draws from a **6-slot
round-robin timbre table** built once per id at boot (per-slot: body pitch
±1.1 st, texture pitch ±1.7 st, Q × 0.85–1.20, decay × 0.86–1.18, level
× 0.93–1.07, and a spectral tilt of ±2.5 dB at 3 kHz). The table advances one
slot per start, so two consecutive plays can never use the same slot. On top of
that, per-shot jitter (the "randomised" line in every recipe) supplies the fine
grain. Two identical waveforms never reach the listener — which is the single
biggest difference between "synthesised game audio" and "a looping sample".

**(3) Mass-death promotion.** If **≥ 5** `actor:death` events land inside
**200 ms**:

- the first two play their individual death voices normally,
- the remaining ones are suppressed,
- **one** `death.mass` voice plays at the arithmetic centroid of all the death
  points, at level `clamp(0.55 + 0.06·n, 0.55, 1.25)` for `n` deaths.

`death.mass` is its own recipe: a 130 → 48 Hz sine sub (drive 5, AD 4/300 ms,
gain 0.9), a brown-noise collapse under a lowpass swept 1 800 → 220 Hz over
420 ms, and 18–26 bone/debris grains scattered over 60–900 ms. It is longer,
deeper and rarer than any individual death, so a pack wipe reads as an *event*
rather than as a bag of gravel hitting the floor.

**(4) Per-frame acquisition budget.** Independent of the above: at most **6**
new spatial voices are built per frame. Excess requests are refused, not queued —
a sound that arrives 33 ms late is worse than no sound.

---

## 5. Synthesis recipes

### 5.0 Notation

- `AD(a, d)` — attack `a` ms (exponential), decay `d` ms (exponential to 1e-4).
- `HIT(d)` — instant attack, exponential decay over `d` ms.
- `ADSR(a, d, s, sl, r)` — ms, ms, ms, sustain level 0..1, ms.
- `sweep(f0 → f1, t)` — exponential ramp on an `AudioParam` over `t` ms.
- `U(a, b)` — uniform draw from the subsystem RNG.
- `st` — semitones; `× 2^(U(−n,n)/12)` is written `± n st`.
- `struck[f Hz, Q, g, decay ms; …]` — a bank of parallel bandpasses excited by a
  short noise burst, each with makeup gain `g · √Q · 0.85` (a high-Q bandpass
  only passes `f/Q` of the excitation's bandwidth; without the makeup every
  metallic sound sits inaudibly low in the mix).
- Noise sources are slices of the `NoiseBank` (`white`, `pink`, `brown`,
  `crackle`), each read from a random offset at a random playback rate.
- "send" is the voice's reverb send level, 0..1.

### 5.1 The catalogue — 263 sounds

★ = full recipe in §5.2. All `sfx` bus unless stated.

#### A. Melee and physical combat — 20

| id | event | ms | nodes | recipe |
|---|---|---|---|---|
| `melee.swing.light` | `skill:cast` (basic) | 260 | 9 | brown-noise band swept 260→720→380 Hz Q 1.2, AD(70,90), + 1 gear ping |
| `melee.swing.heavy` ★R6 | `skill:cast` (2H) | 400 | 12 | see recipe |
| `melee.swing.thrust` | `skill:cast` (pierce) | 200 | 8 | narrow band 900→2200 Hz Q 5.0, AD(60,80), gain 0.28 |
| `melee.miss.whiff` | `actor:damage` blocked=false, amount=0 | 300 | 9 | `swing.light` at 0.7× with the edge layer removed and a 40 ms longer tail |
| `melee.hit.flesh` ★R1 | `actor:damage` surface=flesh | 210 | 11 | see recipe |
| `melee.hit.bone` ★R2 | surface=bone | 160 | 14 | see recipe |
| `melee.hit.metal` ★R3 | surface=metal | 420 | 15 | see recipe |
| `melee.hit.stone` ★R4 | surface=stone | 380 | 16 | see recipe |
| `melee.hit.wood` | surface=wood | 280 | 13 | struck[420,14,0.35,110; 780,11,0.20,70; 1520,8,0.10,40] + 320→190 Hz body + 1500 Hz Q 1.0 texture AD(1.5,45) |
| `melee.hit.crystal` | surface=crystal | 520 | 17 | struck[2140,42,0.34,300; 3390,34,0.24,190; 5720,26,0.16,110; 8930,18,0.08,55] + 6 kHz `crackle` texture AD(2,180) |
| `melee.hit.blood` | surface=blood | 240 | 11 | `hit.flesh` with the squelch layer at 1.6× and the body at 0.6×; texture band 260→720 Hz Q 2.8 |
| `melee.hit.ash` | surface=ash | 300 | 10 | white noise LP swept 1400→380 Hz AD(2,120) g 0.55 + puff LP 900 Hz AD(40,260) g 0.16, no transient |
| `melee.crit` ★R5 | `actor:damage` crit=true | 520 | 18 | see recipe — **layered on top of** the surface hit |
| `melee.block` ★R7 | `actor:damage` blocked=true | 300 | 14 | see recipe |
| `melee.parry` ★R8 | `actor:damage` blocked=true + timing window | 480 | 19 | see recipe |
| `melee.glance` | `actor:damage` vs stoneskin/armour | 260 | 12 | `hit.metal` partials × 0.7 gain + a 3 200→1 400 Hz scrape AD(3,120) |
| `melee.overkill` | `actor:death` with dmg > 2× maxLife | 700 | 24 | `hit.flesh` × 1.4 + a 96→30 Hz sub AD(3,280) + 14–20 wet grains U(180,900) Hz over 0–520 ms |
| `dot.bleed.tick` | `actor:status` bleeding tick | 120 | 6 | pink noise BP 380→640 Hz Q 3.0, AD(6,90), g 0.10; caps at 4 concurrent |
| `knockback.launch` | `actor:damage` knockback>0 | 180 | 7 | brown band 180→640 Hz Q 1.4 rising, AD(4,150), g 0.24 |
| `knockback.land` | actor lands after knockback | 300 | 12 | 82→46 Hz sine AD(4,140) g 0.5 + surface texture from the landing tile + 4 grains |

#### B. Fire spells (Emberwright) — 12

| id | event | ms | nodes | recipe |
|---|---|---|---|---|
| `spell.cast.fire` | `skill:cast` element=fire | 320 | 10 | brown noise LP swept 400→1600 Hz AD(120,180) g 0.30 + 3 crackle grains; a rising "intake" |
| `firebolt.launch` | `projectile:spawn` | 220 | 11 | white noise BP 1200→2800 Hz Q 2.2 AD(2,90) g 0.42 + 140→70 Hz thump + crackle AD(10,180) |
| `firebolt.loop` | tracked, while in flight | loop | 7 | `crackle` at rate 1.1 through BP 1800 Hz Q 1.4, g 0.10, AM by a 7 Hz sine ±40% |
| `firebolt.impact` ★R9 | `skill:impact` | 480 | 16 | see recipe |
| `flamewave.cast` | `skill:cast` Flame Wave | 620 | 15 | brown noise LP swept 5200→600 Hz over 520 ms drive 4, AD(20,560) g 0.7 + crackle bed AD(40,600) |
| `flamewave.loop` | tracked, cone active | 900 | 8 | `crackle` + `brown` through BP 900 Hz Q 0.8, AM 11 Hz, g 0.22 |
| `fireball.launch` | `projectile:spawn` | 300 | 13 | `firebolt.launch` an octave lower, + a 90→48 Hz sub AD(4,220) |
| `fireball.impact` ★R10 | `skill:impact` radius 3.5 m | 1100 | 28 | see recipe |
| `meteor.telegraph` ★R11 | `skill:cast` Meteor, t−1.2 s | 1200 | 11 | see recipe |
| `meteor.impact` ★R11 | `skill:impact` | 1600 | 38 | see recipe |
| `firepool.loop` | tracked, burning ground 6 s | loop | 9 | `crackle` rate U(0.9,1.2) through BP 1400 Hz Q 0.9, g 0.14, + brown LP 320 Hz g 0.06, two LFOs at 0.19 and 0.31 Hz |
| `immolate.explode` | corpse explosion (Incineration) | 700 | 22 | `fireball.impact` at 0.6× with the sub removed and 8 extra grains |

#### C. Ash spells (Emberwright) — 9

| id | event | ms | nodes | recipe |
|---|---|---|---|---|
| `spell.cast.ash` | `skill:cast` element=ash | 300 | 9 | white noise BP swept 2600→700 Hz Q 1.8, AD(90,200), g 0.28 |
| `ashstep.out` ★R14 | `skill:cast` Ash Step | 240 | 9 | see recipe |
| `ashstep.in` ★R14 | arrival, +40 ms | 760 | 12 | see recipe |
| `ashcloud.loop` | tracked, slow field | loop | 7 | brown noise LP 620 Hz g 0.11 with a 2.4 Hz LFO ±90 Hz on the cutoff |
| `ashwall.raise` | `skill:cast` Ash Wall | 900 | 16 | brown noise LP swept 180→900 Hz over 700 ms rising, AD(320,560), g 0.5 + 6 stone grains |
| `ashwall.loop` | tracked, 8 s | loop | 6 | pink noise BP 700 Hz Q 0.7 g 0.09, LFO 0.27 Hz ±0.03 |
| `embershield.on` | `actor:status` shielded | 620 | 13 | 3 sines 440/660/880 Hz AD(180,420) g 0.14 + white noise HP 4 kHz AD(120,400) g 0.08 |
| `embershield.break` ★R15 | shield absorbed → 0 | 900 | 26 | see recipe |
| `manaburn.release` | Burn Essence | 1300 | 24 | pitch-falling sine bank 5×(880→110 Hz over 900 ms) + `fireball.impact` layers at 0.8× |

#### D. Lightning and Runeblade — 14

| id | event | ms | nodes | recipe |
|---|---|---|---|---|
| `spell.cast.lightning` | `skill:cast` element=lightning | 180 | 8 | white noise HP 3 kHz AD(30,120) g 0.22 + a 47 Hz ring-mod buzz |
| `lightning.arc` ★R12 | `skill:impact` | 340 | 16 | see recipe |
| `lightning.chain.jump` | chain to target n | 220 | 8 | `lightning.arc` L1+L2 only, +2 st per jump, 0.7^n gain, at target n's position |
| `resonance.charge` | Resonance pip gained (1..5) | 400 | 5 | one sine at 73.42 × n Hz faded in over 120 ms, held; gains 0.30/0.20/0.12/0.07/0.04 |
| `resonance.seal` | Blade Seal spends Resonance | 520 | 14 | the charge bank swept +5 st over 180 ms then abruptly gated; + `melee.hit.metal` at 0.7× |
| `resonance.discharge` ★R16 | full 5-stack release | 1100 | 30 | see recipe |
| `runestrike` | Rune Strike | 420 | 16 | `melee.hit.metal` + a 293.66 Hz sine AD(6,340) g 0.20 + mana-return shimmer at 1174.7 Hz |
| `cascade.wave` | Cascade auto-wave | 620 | 18 | brown noise band 220→900 Hz Q 1.6 expanding, AD(30,540) g 0.5 + 3 sines D3/A3/D4 AD(40,500) g 0.12 |
| `phaseleap` | Phase Leap teleport-strike | 560 | 20 | `ashstep.out` (bright variant, sweep 4200→900 Hz) + `melee.hit.metal` at destination +90 ms |
| `thunderstep` | Thunder Step dash + AoE | 760 | 22 | dash whoosh 300 ms + `lightning.arc` at 1.3× on arrival + a 62→28 Hz sub |
| `echoblade.spawn` | Echo Blade summoned | 900 | 14 | reverse-envelope pad: 3 sines 293.66/440/587.33 Hz with AD(620,280), through a comb-ish 8 ms delay-free detune of ±14 cents |
| `unity.loop` | tracked, Unity active 8 s | loop | 8 | 73.42 Hz sine + its 3rd and 5th harmonics, g 0.09, AM 5.5 Hz ±30% |
| `skill.polarity.switch` | `polarity` toggled | 340 | 9 | two sine banks crossfading over 220 ms: Blade = 146.83/293.66 Hz through LP 1 800 Hz; Storm = 220/440/659.3 Hz through HP 900 Hz with a 63 Hz-gated shimmer. AD(20,300) g 0.16. The crossfade direction encodes which stance was entered, so the switch is readable blind |
| `echoblade.expire` | the duplicate despawns | 620 | 11 | `echoblade.spawn` reversed: the same three sines (293.66/440/587.33 Hz) with AD(280,340) and a falling ±14-cent detune collapsing to unison, g 0.10 — the duplicate rejoining the caster |

#### E. Cold, poison and status effects — 16

| id | event | ms | nodes | recipe |
|---|---|---|---|---|
| `ice.shard.launch` | `projectile:spawn` element=cold | 260 | 12 | struck[2140,40,0.20,140; 3390,32,0.13,90] + white noise HP 6 kHz AD(4,180) g 0.18 |
| `ice.impact` ★R13 | `skill:impact` element=cold | 420 | 17 | see recipe |
| `frozen.shatter` ★R13 | frozen actor killed | 900 | 34 | see recipe |
| `poison.cloud.loop` | tracked, Blight Crawler cloud | loop | 7 | pink noise BP 620 Hz Q 1.2 g 0.10, LFO 0.42 Hz ±140 Hz; a slow wet churn |
| `status.chilled` | `actor:status` chilled | 320 | 9 | 3 sines 1174/1568/2093 Hz falling −3 st over 260 ms, AD(8,280), g 0.10 |
| `status.frozen` | `actor:status` frozen | 520 | 13 | `ice.impact` L1 + a 2 400→380 Hz downward glissando Q 8, AD(6,460), g 0.22 |
| `status.burning` | `actor:status` burning | 280 | 8 | crackle BP 2 200 Hz Q 1.1, AD(20,240), g 0.16 |
| `status.poisoned` | `actor:status` poisoned | 340 | 9 | pink noise BP swept 900→380 Hz Q 2.6, AD(12,300), g 0.14 + a 3.5 Hz wobble |
| `status.shocked` | `actor:status` shocked | 200 | 8 | white noise HP 5 kHz gated by a 63 Hz square, AD(2,170), g 0.15 |
| `status.stunned` | `actor:status` stunned | 480 | 10 | struck[380,9,0.22,220; 640,7,0.12,140] + a 5 Hz tremolo on the output; a dull ringing |
| `status.slowed` | `actor:status` slowed | 400 | 7 | 2 sines 220/233 Hz (a beating minor 2nd) AD(60,340), g 0.09 |
| `status.bleeding` | `actor:status` bleeding | 240 | 8 | pink BP 420 Hz Q 3.2 AD(6,200) g 0.12 + 2 wet grains |
| `status.blinded` | `actor:status` blinded | 560 | 9 | white noise LP swept 6 000→900 Hz over 480 ms, AD(20,520), g 0.18 — the world closing |
| `status.cursed` | `actor:status` cursed | 720 | 12 | 3 detuned sawtooths 110/116.5/123 Hz (deliberately sour) LP 1 200 Hz, AD(140,600), g 0.14 |
| `dot.burning.tick` | burning DoT tick | 100 | 5 | 2 crackle grains BP 2 600 Hz, HIT(70), g 0.07 |
| `dot.poison.tick` | poison DoT tick | 120 | 5 | pink BP 520 Hz Q 4, AD(8,90), g 0.06 |

#### F. Ravager skills — 10

| id | event | ms | nodes | recipe |
|---|---|---|---|---|
| `skill.cleave` | Cleaving Strike | 460 | 14 | `melee.swing.heavy` + a 120 ms-wide sweep 900→2 600 Hz Q 2.0 (the arc), g 0.24 |
| `skill.rend` | Rend | 380 | 15 | `melee.hit.flesh` at 1.2× + a tearing layer: white BP swept 700→2 400 Hz Q 1.6 AD(4,320) g 0.30 |
| `skill.whirlwind.loop` | tracked, channel | loop | 10 | brown noise BP 340 Hz Q 1.8 AM by a 6.2 Hz sine ±60% + white BP 2 800 Hz Q 3 AM same phase, g 0.28 |
| `skill.bloodthirst.tick` | lifesteal proc | 90 | 4 | pink BP 640 Hz Q 4.5, HIT(70), g 0.05 |
| `skill.rupture.slam` | Rupture | 1000 | 26 | 66→26 Hz sub drive 5 AD(3,380) g 1.0 + ground crack (brown LP 2 200→180 Hz) + 12 stone grains + a −40% armour "crack" shimmer |
| `skill.charge.dash` | Ram Charge, moving | 520 | 12 | brown BP 220→560 Hz Q 1.4 rising, AD(60,440), g 0.42 + gear rattle every 90 ms |
| `skill.charge.impact` | Ram Charge, on contact | 480 | 18 | `melee.hit.metal` × 1.3 + 90→38 Hz sub AD(3,220) + `status.stunned` layered |
| `skill.warcry` | War Cry | 1400 | 20 | player-class shout (formant bank, §5.2 R21 method, f0 128 Hz) + a 620→180 Hz brown swell AD(90,1200) |
| `skill.laststand` | Last Stand triggers | 1600 | 22 | reverse swell 900 ms → a 73.42 Hz sub strike → `embershield.on` at 1.4×; ducks music −8 dB |
| `rage.full` | Rage reaches 100 | 420 | 9 | 2 sines 146.83/220 Hz AD(20,380) g 0.16 + a low brown pulse; once per fill, never repeated within 4 s |

#### G. Monsters — 51

Timbral identities:

| type | identity in one sentence |
|---|---|
| **Bone Ranker** | Dry, reedy and rattling — a thin 140–170 Hz sawtooth larynx over loose bone partials, with almost no low end at all. |
| **Carrion Swarm** | Never one sound — clouds of 1.5 ms chitinous grains between 1.8 and 4.6 kHz behind a stuttering 34 Hz gate, so the swarm's *density* is the timbre. |
| **Ashen Archer** | Taut and woody — every sound is a stretched string or a creaking stave centred 300–900 Hz, ending in a hard 8 ms release transient. |
| **Dust Shaman** | Hollow and pitched — a ring-modulated breath through a fixed three-formant mask, always a perfect fifth above the zone drone, so it reads as ritual rather than animal. |
| **Maulsmith** | The only monster with real sub — 22–90 Hz content in every one of its sounds, and a 1.2 s windup you can hear coming from off screen. |
| **Blight Crawler** | All noise and no metal — wet, pressurised broadband under a rising bandpass, and the only monster whose death is louder than its attack. |

| id | ms | nodes | recipe |
|---|---|---|---|
| `ranker.idle` | 420 | 11 | sawtooth f0 U(148,172) Hz through formants 620/1240/2380 Hz Q 6/8/9, ADSR(20,60,140,0.5,180), g 0.16 + 2 bone ticks |
| `ranker.aggro` | 520 | 13 | same larynx, f0 rising +5 st over 300 ms, g 0.42, drive 2.0, + a 3 300 Hz hiss AD(10,180) |
| `ranker.attack` | 300 | 12 | `melee.swing.light` (dry, brighter) + a 90 ms clipped bark at f0 × 1.3 |
| `ranker.block` | 320 | 13 | struck[380,12,0.3,140; 820,16,0.2,90; 1750,20,0.1,50] (wood-and-iron shield) + a 190→110 Hz thud |
| `ranker.hurt` | 340 | 12 | larynx f0 × 1.25, ADSR(10,40,120,0.4,150) g 0.5, tremolo 17 Hz, + 3 bone grains |
| `ranker.death` ★R17 | 1000 | 26 | see recipe |
| `swarm.idle` | 380 | 10 | 4–7 chitin grains U(1800,4600) Hz Q U(3,7) HIT U(6,18) ms, g U(0.04,0.09), over 0–340 ms |
| `swarm.aggro` | 460 | 12 | `swarm.idle` at 2.2× density + a 34 Hz-gated 1 100 Hz square AD(8,380) g 0.14 |
| `swarm.attack` ★R18 | 240 | 15 | see recipe |
| `swarm.hurt` | 180 | 9 | 2–3 grains + a 620→1 400 Hz wet chirp AD(3,140) g 0.16 |
| `swarm.death` | 320 | 13 | one dry pop (white HP 2 400 Hz HIT(9) g 0.4) + 5–8 shell grains U(2200,6800) Hz over 0–260 ms |
| `swarm.scatter` | 640 | 12 | grain cloud with density ramping 12 → 2 over 600 ms and centre frequency rising 1 800 → 4 200 Hz |
| `archer.idle` | 400 | 9 | creaking stave: white BP swept 380→640 Hz Q 14, AD(140,240), g 0.10 |
| `archer.aggro` | 460 | 12 | larynx f0 U(190,220) Hz, formants 490/1350/1690 Hz ("her" vowel), ADSR(14,50,160,0.5,180) g 0.4 |
| `archer.draw` | 540 | 11 | string tension: BP 300→900 Hz Q 12 rising over 480 ms, AD(180,300), g 0.24 + 4 fibre creaks |
| `archer.release` | 260 | 13 | struck[860,26,0.34,90; 1740,20,0.2,50] (stave snap) + white BP 2 400→5 200 Hz Q 3 AD(1,120) (the arrow) |
| `archer.hurt` | 300 | 11 | larynx f0 × 1.3, ADSR(8,36,100,0.4,140), g 0.45, + a stave crack |
| `archer.death` | 860 | 20 | falling f0 210→84 Hz over 380 ms + stave splintering (7–10 grains U(500,2600) Hz) + `knockback.land` |
| `shaman.idle` | 900 | 12 | ring-modulated breath: white × 110 Hz sine, formants 450/900/2300 Hz, ADSR(220,180,320,0.6,260), g 0.12 |
| `shaman.aggro` | 780 | 14 | the same, f0 165 Hz (a fifth above the D drone), g 0.38, plus a 3-sine chord D4/A4/D5 at g 0.08 |
| `shaman.resurrect` | 1400 | 22 | rising sine bank 110→330 Hz over 1 100 ms + bone reassembly grains (10–14, U(420,3200) Hz) counting up in density |
| `shaman.haste` | 700 | 15 | 4 sines 220/330/440/660 Hz, staggered 60 ms, AD(20,600), g 0.10 each, LP 3 400 Hz |
| `shaman.hurt` | 380 | 12 | ring-mod breath at 1.4× f0, ADSR(8,40,120,0.4,160), g 0.42 |
| `shaman.death` | 1200 | 24 | f0 collapse 165→41 Hz over 700 ms, ring-mod index falling to 0 (the voice loses its pitch) + a dust cloud AD(60,900) |
| `maulsmith.idle` | 700 | 12 | brown noise LP 180 Hz AD(180,480) g 0.22 (breath) + 2 armour clanks struck[380,14,0.1,90] |
| `maulsmith.aggro` | 1100 | 16 | 54 Hz larynx, formants 310/690/1420 Hz, ADSR(60,180,540,0.7,320), drive 2.4, g 0.55, + 31 Hz sub-harmonic at 0.3 |
| `maulsmith.windup` ★R19 | 1200 | 14 | see recipe |
| `maulsmith.slam` ★R19 | 1200 | 30 | see recipe |
| `maulsmith.hurt` | 520 | 14 | 54 Hz larynx at 1.15×, ADSR(12,60,200,0.5,220) g 0.5 + armour rattle (4 pings) |
| `maulsmith.death` | 1800 | 32 | f0 54→26 Hz over 900 ms + full armour collapse (16–22 metal grains U(320,4200) Hz over 200–1 400 ms) + a 58→22 Hz body-fall sub |
| `crawler.idle` | 620 | 10 | pink noise BP 480 Hz Q 1.6 with a 2.8 Hz LFO ±180 Hz, AD(160,420), g 0.12 (wet breathing) |
| `crawler.aggro` | 540 | 12 | a rising hiss: white BP 900→3 400 Hz Q 2.2 over 420 ms, AD(60,460), g 0.34 |
| `crawler.inflate` | 900 | 14 | pink BP 320→1 100 Hz Q 1.8 rising over 800 ms with the gain ramping 0.06 → 0.42; a 4 Hz pulse appearing in the last 300 ms |
| `crawler.hurt` | 260 | 10 | wet pop: white BP 420→1 200 Hz Q 2.4 AD(2,220) g 0.4 |
| `crawler.death` ★R20 | 900 | 24 | see recipe |
| `crawler.chain.fuse` | 640 | 12 | `crawler.inflate` at 0.6× gain, 0.7× duration, +3 st, with the 4 Hz pulse present from the start. A **sympathetic** fuse only, never the primary — a four-Crawler cluster chains over 0.75 s and four copies of the same 900 ms sound reads as a bug |
| `ranker.guard.enter` | 320 | 12 | `ranker.block` with the impact transient removed plus a 0.18 s leather-and-strap creak. Plays on the 0.14 s guard entry, not on a blocked hit — the guard is the player's cue that this Ranker is briefly harder to hurt |
| `ranker.guard.exit` | 220 | 10 | the same creak reversed at 0.6× gain, on the 0.20 s exit |
| `monster.leash` | 900 | 13 | that monster's `idle` at 0.7× gain with a descending 4-sine glide over 700 ms. **Once per pack**, by the first member to leash. De-aggro is otherwise silent, and a pack that walks away without a sound reads as the AI breaking rather than the player escaping |
| `monster.footstep.<surface>` × 12 | — | — | one per `SURFACE`, mirroring `player.footstep.<surface>`: that recipe at 0.55 gain, −2 st, with the boot-leather layer removed. Per-archetype pitch offset — Swarm +7 st, Archer +2 st, Ranker 0, Shaman −1 st, Crawler −3 st (plus a wet layer), Maulsmith **−8 st with a 31 Hz sub**. The Maulsmith is the only monster step with sub content, which is what makes one audible approaching off screen |

#### H. Champions, uniques and monster affixes — 14

| id | ms | nodes | recipe |
|---|---|---|---|
| `champion.aura.loop` | loop | 7 | 2 sines 146.83/220 Hz g 0.05, AM 0.7 Hz ±40%; tracked emitter on the champion |
| `unique.aura.loop` | loop | 9 | 3 sines 73.42/146.83/293.66 Hz g 0.06/0.045/0.03 + a 5 200 Hz shimmer AM 0.4 Hz; unmistakably a fifth louder than `champion` |
| `unique.spawn` | 1600 | 18 | a rising drone 36.71→73.42 Hz over 1 200 ms + one 293.66 Hz bell partial (Q 50, decay 900 ms); ducks ambience −8 dB |
| `affix.fire.death` | 800 | 22 | `fireball.impact` at 0.7× with the crackle layer doubled |
| `affix.lightning.charge` | 300 | 10 | `lightning.arc` L1 only + a 63 Hz-gated sizzle AD(6,260) |
| `affix.cold.aura.loop` | loop | 7 | white noise HP 7 kHz g 0.04 + a 2 093 Hz sine g 0.02, AM 0.9 Hz |
| `affix.curse.cast` | 900 | 14 | `status.cursed` at 1.4× + a descending 3-sawtooth glide 220→110 Hz |
| `affix.vampiric.tick` | 110 | 5 | pink BP 560 Hz Q 5, HIT(90), g 0.05 |
| `affix.stoneskin.deflect` | 280 | 12 | `melee.hit.stone` with the transient at 1.4× and the body at 0.5× |
| `affix.multishot` | 340 | 14 | 3 × `archer.release` staggered 40/80 ms at 1.0/0.8/0.65 gain and +0/+2/+4 st |
| `monster.enrage` | 700 | 13 | that monster's `aggro` sound pitched +4 st with a 9 Hz tremolo and a 220 Hz sub added. **Not used for Molgrim** — his `aggro` is `boss.spawn`, a 3 400 ms cue that ducks everything, and the enrage stack fires every 15 s. See `boss.enrage` |
| `champion.spawn` | 900 | 16 | `unique.spawn` at 0.5× level, 0.55× duration, one octave up, without the bell partial; ducks ambience −4 dB. Without it a champion pack arrives silently |
| `affix.swift.loop` | loop | 6 | a 6.4 Hz amplitude-gated pink band at 2 800 Hz Q 3.5, g 0.03, tracked on the emitter |
| `affix.mighty.impact` | 300 | 8 | layered **on top of** the surface hit: a 62→38 Hz sub AD(4,260) g 0.22 plus one 180 Hz body partial |

#### I. Molgrim, the First Instructor — 15

| id | ms | nodes | recipe |
|---|---|---|---|
| `boss.spawn` | 3400 | 26 | stone grind (brown BP 140→380 Hz Q 3.5, AD(400,2 600), g 0.34) + the choir shadow (4 sines D2/A2/D3/F3) rising over 2 400 ms; ducks everything |
| `boss.p1.swing` | 700 | 16 | `melee.swing.heavy` an octave down (all band centres × 0.5), 620 ms, + a stone scrape |
| `boss.p1.summon` | 1400 | 24 | descending sine bank 440→110 Hz + 4 × `ranker.aggro` scheduled at 0/220/440/660 ms around the boss |
| `boss.p1.roar` | 1800 | 24 | the R21 recipe at 0.7× level and 1.8 s |
| `boss.p2.transition` ★R21 | 3400 | 34 | see recipe |
| `boss.p2.firering` | 2200 | 30 | expanding ring: brown noise BP 220 Hz Q 1.2 whose centre rises 220→900 Hz over 1 800 ms, g 0.55, + crackle bed + a 62→24 Hz sub on the launch |
| `boss.p2.dash` | 900 | 18 | `skill.charge.dash` at 0.6× rate (deeper, slower) + a stone-on-stone grind |
| `boss.p3.transition` | 3400 | 34 | R21 with f0 = 54 Hz, the choir shifted to D/Ab/D (the tritone), and the gravel layer at 1.4× |
| `boss.p3.teleport` | 700 | 16 | `ashstep.out` an octave down at the origin + `ashstep.in` an octave down at the destination, 90 ms apart |
| `boss.p3.meteorrain` | 4000 | 40 | 5 × `meteor.telegraph` staggered U(0,2 400) ms at 0.6× + 5 × `meteor.impact` at 0.7×; hard-capped at 3 concurrent impacts |
| `boss.p3.manaburn.loop` | loop | 9 | an inverted drone: 3 sines 73.42/103.8/155.6 Hz (root, tritone, minor 6th) g 0.07, AM 0.6 Hz; the only permanently dissonant loop in the game |
| `boss.hurt` | 900 | 18 | R21's larynx at 0.5 level, 700 ms, no choir, no grind |
| `boss.stagger` | 1400 | 22 | falling f0 62→38 Hz + full armour/stone collapse (18 grains) + a 44→20 Hz sub |
| `boss.enrage` | 1400 | 20 | `boss.p1.roar` at +3 st with a 7 Hz tremolo and a 44 Hz sub; one instance per enrage stack. This exists because the generic `monster.enrage` recipe would resolve to `boss.spawn` for Molgrim |
| `boss.death` | 6000 | 44 | R21 with f0 collapsing 62→21 Hz over 3 200 ms, the choir *rising* to D4/A4/D5 over the last 2 400 ms, and a 2 400 ms stone-collapse grain field; ducks every other bus by 20+ dB |

#### J. Player — 24

Footsteps are head-locked (no panner, no distance, no delay). Two contacts, heel
at `t0` and toe at `t0 + U(14,30)` ms at 0.45× gain; the toe contact is what
makes it read as a foot rather than a hammer.

| surface | body Hz | body decay ms | texture src | tex Hz | tex Q | tex decay ms | tex level | scuff | grains | ring partials | send |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `stone` | 92 | 55 | white | 2 100 | 0.70 | 45 | 0.50 | 0.35 | 4 | — | 0.35 |
| `dirt` | 78 | 70 | brown | 620 | 0.60 | 75 | 0.62 | 0.45 | 5 | — | 0.22 |
| `grass` | 80 | 50 | crackle | 1 900 | 0.55 | 110 | 0.55 | 0.55 | 3 | — | 0.18 |
| `sand` | 70 | 60 | white | 1 500 | 0.45 | 140 | 0.60 | 0.70 | 2 | — | 0.16 |
| `ash` ★R23 | 68 | 62 | white | 1 450 | 0.45 | 150 | 0.50 | 0.62 | **0** | — | 0.25 |
| `wood` | 110 | 60 | white | 1 300 | 0.80 | 40 | 0.40 | 0.28 | 2 | 260 Q12 / 540 Q9 | 0.30 |
| `metal` | 120 | 50 | white | 3 200 | 1.00 | 40 | 0.50 | 0.30 | 2 | 620 Q16 / 1 480 Q20 / 2 900 Q14 | 0.45 |
| `water` | 88 | 45 | white | 1 600 | 0.70 | 170 | 0.80 | 0.50 | 3 | splash sweep 700→3 400 Hz | 0.30 |
| `bone` | 104 | 42 | crackle | 2 600 | 0.85 | 95 | 0.58 | 0.25 | 7 | 480 Q10 / 1 120 Q14 | 0.38 |
| `flesh` | 86 | 55 | white | 520 | 1.20 | 50 | 0.35 | 0.20 | 0 | — | 0.20 |
| `blood` | 84 | 48 | pink | 640 | 1.60 | 120 | 0.55 | 0.42 | 0 | wet sweep 260→900 Hz | 0.24 |
| `crystal` | 96 | 35 | crackle | 5 200 | 0.80 | 190 | 0.60 | 0.30 | 8 | 2 140 Q40 / 3 390 Q32 / 5 720 Q24 | 0.50 |

Body layer: sine at `bodyF ± 3 st`, swept `1.7× → 0.75×` over `1.4 × decay`,
through `tanh` drive 1.8 asym 0.5, `AD(2.5, decay × U(0.85,1.2))`, gain 0.42 × level.
Texture: the named noise source, bandpass at `texF ± 3 st` swept `1.4× → 0.55×`
over `2 × texDecay`, `AD(2, texDecay × U(0.8,1.3))`.
Scuff: white noise BP U(2 200,4 200) Hz swept down 40%, `AD(12, 70)`, gain `scuff × 0.5`.
Grains: `struck[U(2400,9000) Hz, Q U(10,26), g U(0.015,0.05), decay U(8,30) ms]`,
each emitted with probability 0.55.

Ash's defining feature is the **absence** of grains — ash has no hard particles.
That absence is exactly what separates it from `dirt` and `sand` by ear.

| id | ms | nodes | recipe |
|---|---|---|---|
| `player.footstep.<surface>` ×12 | 240–380 | 10–16 | table above; `player.footstep.ash` ★R23 |
| `player.hurt.ravager` | 420 | 12 | larynx f0 118 Hz, formants 640/1200/2500 Hz, ADSR(10,40,120,0.45,180), drive 2.2, g 0.42 |
| `player.hurt.emberwright` | 380 | 12 | f0 168 Hz, formants 530/1840/2480 Hz, ADSR(8,34,100,0.4,160), g 0.38 |
| `player.hurt.runeblade` | 400 | 12 | f0 142 Hz, formants 570/840/2410 Hz, ADSR(9,38,110,0.42,170), g 0.40 |
| `player.death` | 2600 | 26 | class larynx with f0 collapsing to 0.45× over 900 ms + a dying exhale (white BP 900→380 Hz AD(80,600)) + a 62→24 Hz sub; ducks sfx −12 dB |
| `player.levelup` ★R25 | 1600 | 22 | see recipe |
| `player.lowlife.heartbeat` ★R24 | 620 | 10 | see recipe |
| `potion.drink.life` | 700 | 14 | 3 liquid gulps (sine 220→130 Hz, AD(6,90), staggered 160 ms) + a glass clink struck[2 800,34,0.12,90] + a warm 293.66 Hz swell AD(60,420) g 0.10 |
| `potion.drink.mana` | 700 | 14 | as above but the swell is 440 Hz + a 1 760 Hz shimmer, and the gulps are pitched +4 st |
| `player.respawn` | 1800 | 20 | reverse swell 1 200 ms (pink BP 300→2 400 Hz, AD(1 100,600)) → a 73.42 Hz sub strike → the town bed fading up |
| `player.cast.fail` | 220 | 7 | 2 squares 220/233 Hz LP 1 400 Hz, AD(3,190), g 0.22 — the same sour dyad as `ui.error`, one octave down |
| `player.portal.enter` | 1200 | 18 | rising sine bank 110→880 Hz over 900 ms + white noise HP swept 800→9 000 Hz, AD(300,800) |
| `player.portal.exit` | 1200 | 18 | the same, reversed (falling), plus the destination zone's bed crossfading in over 800 ms |

#### K. Items and economy — 25

**The rarity ladder is a note-count ladder.** A player must be able to rank a
drop by ear before the label renders, and the way we do that is by adding one
pitch per tier:

| rarity | pitched content | length | peak (rel. master) | send |
|---|---|---|---|---|
| normal | none — one dull thud | 140 ms | −14 dB | 0.18 |
| superior | one ping (2 400 Hz) | 220 ms | −13 dB | 0.24 |
| magic | **two** rising notes D5 → A5 (587.3 → 880.0 Hz) | 380 ms | −12 dB | 0.40 |
| rare | **three** rising notes D5 → F♯5 → A5 (587.3 → 740.0 → 880.0 Hz), 90 ms apart | 700 ms | −9 dB | 0.60 |
| **unique** | **a seven-partial bell** on D4, with a hum note an octave below | 2 400 ms | **−3 dB** | **0.95** |

| id | ms | nodes | recipe |
|---|---|---|---|
| `drop.normal` | 140 | 8 | 190→110 Hz sine AD(2,110) g 0.4 + white BP 1 400 Hz Q 0.9 AD(1.5,80) g 0.28 |
| `drop.superior` | 220 | 10 | `drop.normal` + struck[2 400,30,0.12,180] |
| `drop.magic` | 380 | 14 | `drop.normal` + 2 sines 587.3/880.0 Hz, onsets 0/110 ms, AD(6,260) g 0.14 |
| `drop.rare` | 700 | 18 | `drop.normal` + 3 sines 587.3/740.0/880.0 Hz, onsets 0/90/180 ms, AD(6,480) g 0.15 + 4 shimmer grains |
| `drop.unique` ★R22 | 2400 | 55 | see recipe |
| `drop.gold` | 520 | 20 | 6–11 coin pings struck[U(3200,6400) Hz, Q U(34,58), g U(0.05,0.12), decay U(20,70) ms] over 0–380 ms + a 220 Hz body; **coalescing window 200 ms** |
| `drop.potion` | 260 | 11 | struck[1 900,26,0.18,140; 3 700,20,0.09,70] (glass) + a 240→150 Hz body |
| `drop.scroll` | 200 | 9 | white BP 1 100→2 600 Hz Q 1.2 AD(8,160) g 0.18 (parchment) + one soft tick |
| `pickup.item` | 220 | 10 | rising pair 880/1 174.7 Hz, onsets 0/60 ms, AD(4,150), g 0.14 + a cloth rustle |
| `pickup.gold` | 300 | 14 | 4–7 coin pings, tighter and higher than `drop.gold`, + a 1 174.7 Hz ping; window 200 ms |
| `pickup.potion` | 200 | 9 | `drop.potion` reversed in pitch order, 0.7× gain |
| `equip.cloth` | 340 | 9 | white BP 1 300→2 400 Hz Q 0.55, AD(30,280), g 0.24 |
| `equip.leather` | 380 | 11 | brown BP 620 Hz Q 0.8 AD(24,300) g 0.28 + 2 buckle pings struck[2 600,28,0.06,50] |
| `equip.mail` | 520 | 18 | 9–14 ring pings struck[U(3400,7200) Hz, Q U(28,46), g U(0.03,0.07), decay U(15,55) ms] over 0–320 ms + a 180 Hz body |
| `equip.plate` | 620 | 16 | struck[380,12,0.34,220; 820,16,0.22,140; 1 750,20,0.12,80] + a 120→70 Hz body AD(3,180) |
| `equip.blade` | 480 | 14 | a scabbard draw: white BP 1 800→4 600 Hz Q 3.2 over 240 ms AD(20,200) g 0.3, then struck[2 350,44,0.2,380; 3 720,36,0.12,240] |
| `equip.jewelry` | 300 | 10 | struck[4 400,52,0.1,240; 6 600,40,0.05,140] — small, bright, and long-tailed |
| `unequip` | 260 | 8 | the equip sound of the slot's material at 0.6× gain with the pitched layer removed |
| `identify.scroll` | 1100 | 18 | parchment rustle 300 ms → a 4-sine reveal D4/F4/A4/D5 rising over 620 ms, AD(40,600), g 0.10 each |
| `stash.open` | 620 | 14 | wood-and-iron: struck[190,9,0.3,260; 420,12,0.2,160] + a hinge creak (white BP 620→1 100 Hz Q 18, AD(140,300)) |
| `stash.close` | 480 | 12 | the hinge creak reversed + a 140→80 Hz thud AD(2,200) |
| `vendor.buy` | 420 | 14 | `pickup.gold` at 0.8× + a 587.3 Hz confirm ping AD(6,300) |
| `vendor.sell` | 420 | 14 | `drop.gold` at 0.8× + a 440 Hz ping (a fourth below `buy`, so buy and sell are distinguishable blind) |
| `repair` | 900 | 20 | 3 anvil strikes struck[420,16,0.3,180; 980,22,0.18,110; 2 100,18,0.08,60] at 0/260/520 ms + a hiss AD(40,400) |
| `item.break` | 700 | 22 | `melee.hit.metal` at 1.3× + 10–14 fragment grains U(1800,7200) Hz over 40–520 ms + a descending 440→110 Hz glide |

#### L. UI — 14

All head-locked, `ui` bus, no reverb send unless noted.

| id | ms | nodes | recipe |
|---|---|---|---|
| `ui.hover` | 14 | 3 | struck[1 850,26,0.06,14]; 0.35× of `ui.click` |
| `ui.click` ★R26 | 34 | 6 | see recipe |
| `ui.error` | 220 | 6 | 2 squares 220/233 Hz LP 1 800 Hz, AD(3,180), g 0.30 — a minor second, deliberately sour |
| `ui.inv.pickup` | 60 | 5 | white BP 2 200 Hz Q 1.6 HIT(30) g 0.22 + struck[3 200,30,0.05,40] |
| `ui.inv.place` | 90 | 6 | 150→95 Hz sine AD(1,70) g 0.26 + struck[1 400,22,0.06,60] |
| `ui.inv.invalid` | 140 | 5 | one 165 Hz square LP 900 Hz, AD(2,120), g 0.24 |
| `ui.skillpoint` | 520 | 12 | 2 sines 587.3/880.0 Hz onsets 0/90 ms AD(6,400) g 0.16 + 3 shimmer grains; send 0.35 |
| `ui.statpoint` | 380 | 9 | one 440 Hz sine AD(6,320) g 0.16 + a 220 Hz body |
| `ui.quest.update` | 620 | 12 | 3 sines 440/587.3/659.3 Hz staggered 110 ms, AD(10,460), g 0.12; send 0.4 |
| `ui.quest.complete` | 1800 | 22 | D–A–D–F arpeggio 293.66/440/587.3/698.5 Hz staggered 180 ms, AD(12,900), g 0.16, + a 73.42 Hz sub and a 900 ms shimmer; ducks music −8 dB |
| `ui.panel.open` | 180 | 8 | white BP 900→2 600 Hz Q 1.4 AD(10,150) g 0.20 |
| `ui.panel.close` | 160 | 8 | the same sweep reversed, 0.85× gain |
| `ui.map.toggle` | 120 | 6 | struck[1 200,18,0.1,90; 2 400,14,0.05,50] |
| `ui.dialogue.advance` | 60 | 5 | `ui.click` at 0.7× with the high partial removed |

#### M. World objects — 11

| id | ms | nodes | recipe |
|---|---|---|---|
| `portal.open` | 2200 | 24 | rising sine bank 55→880 Hz over 1 600 ms (5 partials) + white noise HP swept 400→11 000 Hz AD(900,1 100) g 0.3 |
| `portal.close` | 1400 | 20 | the same, falling, over 1 000 ms, with the noise layer at 0.6× |
| `portal.travel` | 1600 | 22 | a 300 ms suction (BP 3 400→400 Hz Q 3) → 400 ms near-silence (world ducked −18 dB) → the destination bed and an 880→293.66 Hz settle |
| `portal.loop` handled by `world` | loop | 8 | 2 sines 146.83/220 Hz g 0.05 + white HP 6 kHz g 0.02, AM 0.5 Hz; tracked |
| `door.open` | 900 | 16 | hinge creak: white BP 380→1 400 Hz Q 20 over 700 ms AD(200,500) g 0.26 + a 110→70 Hz drag |
| `chest.open` | 800 | 18 | latch struck[2 400,32,0.16,60] → lid creak 400 ms → struck[190,10,0.24,240] thunk |
| `chest.locked` | 260 | 10 | struck[1 600,28,0.14,70; 3 200,20,0.06,35] + a dull 140 Hz thud; no pitched content, so it reads as refusal |
| `waypoint.activate` | 1600 | 20 | a rising 5-partial drone on D (73.42 × 1,2,3,4,5) over 1 200 ms + a bell partial at 587.3 Hz Q 48 |
| `brazier.loop` | loop | 8 | `crackle` at rate U(0.85,1.15) through BP 1 600 Hz Q 0.9 g 0.10 + brown LP 300 Hz g 0.04; two LFOs at 0.23/0.37 Hz |
| `forge.loop` | loop | 9 | brown LP 220 Hz g 0.08 (bellows, LFO 0.4 Hz ±60%) + a scheduled anvil strike every U(2.5,6.0) s |
| `altar.hum.loop` | loop | 7 | 3 sines 36.71/73.42/110 Hz g 0.07/0.05/0.03, AM 0.11 Hz ±25% |

#### N. Ambience — 23

Beds are **continuous, LFO-driven, and never scheduled from JS**: audio-rate
oscillators modulate gains and filter cutoffs, so a bed costs zero main-thread
time and is literally never in the same state twice. Each bed is 3 layers behind
a shared `bedLP` + `bedGain` pair, with a 0.20 tap into the reverb send so
interiors get a wash of the outside rather than a dead room.

| id | layers | scheduling |
|---|---|---|
| `bed.town` | **fire**: brown LP 300 Hz g 0.07, LFO 0.29 Hz ±40%. **stone/wind**: brown LP U(240,420) Hz g 0.10 × 2 decorrelated layers panned ±0.5, LFOs at 0.041/0.0917 Hz on gain and 0.037 Hz ±140 Hz on cutoff. **life**: pink BP 520 Hz Q 0.6 g 0.045, LFO 0.023 Hz. | one-shots every U(6,18) s |
| `bed.wastes` | **wind**: 2 brown layers LP U(260,520) Hz g 0.12 panned ±0.55, four incommensurate LFOs (0.041/0.0917/0.037/0.058 Hz) so the sum never audibly repeats. **ash**: white BP 4 200 Hz Q 0.5 g 0.035, LFO 0.071 Hz ±0.02 — a fine dry hiss that *is* the zone. **void**: brown LP 90 Hz g 0.06, LFO 0.0137 Hz. | one-shots every U(5,16) s; gusts every U(5,16) s |
| `bed.bonereach` | **drone**: brown LP 110 Hz g 0.08, LFO 0.019 Hz. **air**: white BP 620 Hz Q 4.0 g 0.025, LFO 0.053 Hz ±380 Hz (a faint whistle through the corridors). **pressure**: pink LP 340 Hz g 0.05, LFO 0.031 Hz. | one-shots every U(7,22) s |
| `bed.altar` | **choir**: 3 sines 73.42/110/146.83 Hz g 0.055/0.04/0.03, each with an independent 0.017–0.029 Hz LFO ±30% and ±4 cent drift. **ember**: `crackle` BP 1 800 Hz g 0.05. **stone**: brown LP 140 Hz g 0.07. | one-shots every U(9,26) s |

Gusts (Wastes only): a `_gust()` every U(5,16) s ramps each wind layer's gain to
`0.5 + 0.5·strength` and its cutoff to `× (1 + 0.9·strength)` over `0.28 × dur`,
then back over `0.4 × dur`, where `dur = U(2.2, 6.5)` s and
`strength = U(0.25, 1.0)`.

| one-shot | zone | ms | recipe |
|---|---|---|---|
| `town.forge.hammer` | town | 700 | 3 anvil strikes at 0/240/470 ms, struck[420,16,…; 980,22,…], placed at the forge |
| `town.bell` | town | 4200 | 5-partial bell on A3 (220 Hz, ratios 0.5/1/1.19/1.56/2.0), Q 60→24, decays 3 600→600 ms; once per U(90,240) s |
| `town.murmur` | town | 1400 | 2 sawtooths 110/117 Hz through formants 600/1 300 Hz, AD(300,900), g 0.10 — contour only, never words |
| `town.cart` | town | 3600 | brown LP 260 Hz AD(900,2 200) g 0.10 + 9–14 wheel creaks over 3 000 ms |
| `town.dog` | town | 900 | 2–3 barks: sawtooth 340→180 Hz AD(10,100) through BP U(700,1 200) Hz Q 2.2 |
| `wastes.gust` | wastes | 3800 | handled by `_gust()` on the bed, not a voice |
| `wastes.ashhiss` | wastes | 2600 | white BP 3 800 Hz Q 0.6 AD(700,1 700) g 0.12, panned to a random azimuth |
| `wastes.tree.creak` | wastes | 1800 | white BP swept 500→1 900 Hz Q 22, AD(500,1 200), g 0.22, then one struck pop at 0.9 × dur |
| `wastes.moan` | wastes | 2800 | a distant Molgrim-adjacent voice: 62 Hz larynx, formants 310/690 Hz, ADSR(600,300,900,0.5,900), g 0.10 |
| `wastes.bird` | wastes | 1600 | 3–6 sine chirps U(2 600,4 600) Hz sweeping ±40% over 60 ms, scattered over 1 400 ms, g 0.04 |
| `wastes.bone.clatter` | wastes | 900 | 6–10 bone grains U(420,3 200) Hz over 0–700 ms, g U(0.02,0.07) |
| `crypt.drip` | bonereach | 600 | sine 900→2 400 Hz over 45 ms AD(1,60) g 0.10 + a struck 1 400 Hz Q 30 tail; send 0.9 |
| `crypt.bone.settle` | bonereach | 1100 | 7 grains U(600,5 000) Hz over 0–700 ms + a 90→55 Hz thump |
| `crypt.chain` | bonereach | 1400 | 8–14 links struck[U(2800,5600) Hz, Q U(30,50), decay U(20,60) ms] over 0–1 100 ms |
| `crypt.scrape` | bonereach | 1800 | brown BP 180→420 Hz Q 3.5 AD(400,1 300) g 0.16 |
| `crypt.breath` | bonereach | 2200 | white BP 700→380 Hz Q 0.55 AD(600,1 500) g 0.09 — the dungeon exhaling |
| `altar.ember.pop` | altar | 400 | 2–4 crackle grains BP 2 200 Hz + one 140 Hz body tick |
| `altar.stone.grind` | altar | 2600 | brown BP 140→380→160 Hz Q 3.5, AD(600,1 900), g 0.20 |
| `altar.whisper` | altar | 2000 | 4 sines D4/E♭4/A4/A♭4 (293.66/311.1/440/415.3 Hz) at g 0.02 each, staggered 300 ms, AD(500,1 400) — the tritones make it wrong on purpose |

#### O. Music — 5

| id | always running | nodes | recipe |
|---|---|---|---|
| `music.drone` | yes | 13 | 2 sines 36.71/73.42 Hz + 1 sawtooth 110 Hz through LP 320 Hz; LFOs at 0.031/0.047/0.019 Hz ±25% on gain |
| `music.pad` | yes | 6 | 4 sawtooths D3/F3/A3/C4 (146.83/174.61/220.00/261.63 Hz) detuned ±7 cents, LP Q 1.2 with cutoff following intensity 620 → 1 900 Hz |
| `music.pulse` | scheduled | 6 | brown noise BP 180 Hz Q 2.2, AD(90,620); every 2 beats |
| `music.lead` | scheduled | 4 | triangle from {D,F,G,A,C}, AD(240,1 800), LP 2 400 Hz; one note per 2 bars |
| `music.perc` | scheduled | 9 | sine 82→48 Hz AD(2,180) + struck[190,8,…; 420,8,…; 860,8,…]; beats 1 and 3 |

### 5.2 Full recipes

Every recipe's randomised parameters are drawn from the `audio` RNG stream and
never from gameplay RNG.

---

#### R1 — `melee.hit.flesh`

The most-heard sound in the game. It has to survive ten thousand repetitions
without becoming a tic, which is why it carries no pitched content at all.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 contact | white noise | bandpass 520 Hz Q 1.6 | AD(0.4, 34) | 0.62 |
| L2 body | sine, sweep 132 → 62 Hz over 70 ms | `tanh` drive 2.2 asym 0.45 | AD(1.5, 85) | 0.55 |
| L3 squelch | pink noise | bandpass swept 300 → 850 Hz over 90 ms, Q 2.4 | AD(5, 110) | 0.34 |
| L4 rag | white noise | bandpass 1 800 Hz Q 0.7 | AD(12, 70) | 0.12 |

Randomised: L1/L3 centres ± 3 st; L2 start frequency ± 2 st; all decays
× U(0.85, 1.20); overall level × U(0.92, 1.08); 6-slot round-robin with ± 2.5 dB
tilt at 3 kHz. Length 210 ms, tail to 260 ms. Send 0.20. 11 nodes.

---

#### R2 — `melee.hit.bone`

Dry, cracky, high-mid, and 50 ms shorter than flesh. Almost no low end — that
absence is the identity.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 crack | white noise | highpass 1 400 Hz + peaking +9 dB @ 3 200 Hz Q 1.6 | HIT(9) | 0.85 |
| L2 snap | 2.5 ms white burst | `struck[640 Q22 g0.45 d55; 1180 Q18 g0.30 d34; 2450 Q12 g0.16 d18]` | — | — |
| L3 body | triangle, sweep 150 → 88 Hz over 45 ms | — | AD(1, 55) | 0.30 |
| L4 splinters | 3–5 grains | `struck[U(2200,7800) Hz, Q U(12,28), g U(0.02,0.055), decay U(8,34) ms]` at `t0 + U(18,70)` ms | — | — |

Randomised: all partials ± 3 st together, then ± 0.8 st each; Q × U(0.8, 1.25);
grain count `3 + ⌊U(0,3)⌋`. Length 160 ms. Send 0.28. 14 nodes.

---

#### R3 — `melee.hit.metal`

The long ring is the whole point; a metal hit whose partials decay in 80 ms
sounds like a plastic toy.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 strike | white noise | highpass 3 200 Hz | HIT(6) | 0.70 |
| L2 ring | 2.5 ms white burst | `struck[1420 Q34 g0.40 d320; 2680 Q28 g0.28 d190; 4750 Q20 g0.17 d95; 7900 Q13 g0.08 d45]` | — | — |
| L3 body | sine, sweep 175 → 110 Hz over 40 ms | — | AD(1, 50) | 0.28 |
| L4 spark (p = 0.35) | white noise | bandpass swept 4 200 → 6 800 Hz over 60 ms, Q 3.0 | AD(4, 70) | 0.16 |

Randomised: the partial set detuned ± 3 st as a group, then ± 0.8 st each;
decays × U(0.75, 1.35); Q × U(0.80, 1.25). Length 420 ms. **Send 0.42** — metal
is the one melee sound that should tell you what room you are in. 15 nodes.

---

#### R4 — `melee.hit.stone`

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 contact | white noise | highpass 2 600 Hz | HIT(5) | 0.55 |
| L2 body | sine, sweep 210 → 120 Hz over 55 ms | `tanh` drive 3.0 | AD(1, 60) | 0.50 |
| L3 grit | white noise | bandpass swept 2 400 → 1 100 Hz, Q 0.9 | AD(1.5, 80) | 0.60 |
| L4 dust | white noise | lowpass swept 1 300 → 520 Hz | AD(22, 300) | 0.16 |
| L5 chips | 4–6 grains | `struck[U(1800,6500) Hz, Q U(10,24), g U(0.02,0.05), decay U(10,45) ms]` over `t0 + U(15,120)` ms | — | — |

Randomised: centres ± 2.5 st; dust decay × U(0.8, 1.3); chip count
`4 + ⌊U(0,3)⌋`. Length 380 ms. Send 0.34. 16 nodes.

---

#### R5 — `melee.crit`

Layered **on top of** the surface hit, never instead of it. The hit-stop is
90 ms, so the transient must be inside the first 10 ms and the body must arrive
as the world resumes.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 sub | sine, sweep 78 → 34 Hz over 140 ms | `tanh` drive 4.5 asym 0.6 → lowpass 200 Hz Q 0.9 | AD(3, 160) | 0.90 |
| L2 snap | white noise | highpass 4 200 Hz | HIT(7) | 0.75 |
| L3 shimmer | 3 sines at 1 860 / 2 790 / 3 720 Hz (1 : 1.5 : 2) | — | AD(90, 240) — a *rising* swell that peaks after the impact | 0.18 total |
| L4 tail | pink noise | lowpass swept 5 200 → 700 Hz over 260 ms | AD(8, 280) | 0.25 |

L3's late peak is what makes a crit feel like a consequence rather than a louder
hit. Duck: `sfx` −3 dB, 25 ms attack, 120 ms hold, 260 ms release.

Randomised: L1 start ± 0.6 st; L3 partials ± 1 st as a group; decays
× U(0.9, 1.15). Length 520 ms. Send 0.45. 18 nodes.

---

#### R6 — `melee.swing.heavy`

Duration is driven by the animation: `skills` passes `dur` (clamped 180–420 ms)
and **every envelope time scales by `dur / 300`**.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 air | brown noise | bandpass swept 260 → U(760,1 080) → 340 Hz (rise over 55% of `dur`, fall over 45%), Q 1.4 | AD(90, 130) | 0.45 |
| L2 edge | white noise | bandpass swept 1 600 → U(3 600,4 900) Hz, Q 3.2 | AD(120, 60) | 0.16 |
| L3 gear | 1–2 grains | `struck[U(1600,3800) Hz, Q U(20,36), g U(0.03,0.08), decay U(30,90) ms]` at `t0 + U(10,60)` ms | — | — |

L2's peak lands *after* L1's — the blade tip is fastest at the end of the arc,
and that late brightness is the difference between a whoosh and a wind sound.

**Send 0.12.** A wet whoosh turns into a wash. Randomised: as marked, plus
overall gain × U(0.90, 1.12). Length ≈ `dur` + 130 ms. 12 nodes.

---

#### R7 — `melee.block`

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 thud | sine, sweep 128 → 74 Hz over 60 ms | `tanh` drive 3.5 | AD(1.5, 75) | 0.62 |
| L2 boss | 3 ms white burst | `struck[310 Q12 g0.35 d120; 720 Q16 g0.24 d75; 1580 Q22 g0.14 d45; 3900 Q30 g0.06 d180]` | — | — |
| L3 scrape | white noise | bandpass swept 2 200 → 1 200 Hz, Q 1.1 | AD(3, 90) | 0.22 |

The 3 900 Hz partial with a 180 ms decay is the iron rim; without it the block
sounds like a wooden board. Randomised: partial set ± 2.5 st; decays
× U(0.8, 1.25). Length 300 ms. Send 0.30. 14 nodes.

---

#### R8 — `melee.parry`

A block **falls**; a parry **rises**. That one contour difference is the entire
design and it is legible in 90 ms.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 blades | 1.8 ms white burst | `struck[2350 Q44 g0.42 d420; 3720 Q36 g0.28 d260; 5900 Q26 g0.16 d140; 9100 Q18 g0.07 d70]` | — | — |
| L2 zing | sine, sweep 2 350 → 3 100 Hz over 90 ms | — | AD(2, 240) | 0.13 |
| L3 sparks | 5–8 grains | `struck[U(4500,11000) Hz, Q U(20,40), g U(0.01,0.035), decay U(6,26) ms]` over `t0 + U(0,45)` ms | — | — |

Randomised: partials ± 2 st as a group; L2 endpoints ± 1.5 st; spark count
`5 + ⌊U(0,4)⌋`. Length 480 ms. Send 0.45. 19 nodes.

---

#### R9 — `firebolt.impact`

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 ignition | white noise | highpass 1 800 Hz → `tanh` drive 6 asym 0.5 | HIT(12) | 0.50 |
| L2 whump | sine, sweep 118 → 52 Hz over 130 ms | lowpass 240 Hz | AD(3, 150) | 0.55 |
| L3 flame body | brown noise | bandpass swept 900 → 260 Hz, Q 0.8 → `tanh` drive 3.5 | AD(6, 220) | 0.60 |
| L4 crackle | `crackle` buffer, rate U(0.85, 1.30) | bandpass 2 600 Hz Q 1.0 | AD(25, 320) | 0.22 |
| L5 hiss | pink noise | highpass 3 200 Hz | AD(30, 380) | 0.10 |

L4 is what makes fire read as *fire* rather than as a gust of air; drop it and
the whole family collapses into "explosion". Randomised: all centres ± 2 st;
decays × U(0.85, 1.25). Length 480 ms. Send 0.35. 16 nodes.

---

#### R10 — `fireball.impact`

R9's skeleton, scaled up, plus three layers R9 does not have.

| layer | change from R9 | value |
|---|---|---|
| L2 sub | lower and longer | sine 90 → 32 Hz over 260 ms, AD(4, 280), gain 0.95 |
| L3 body | longer | 260 ms |
| L4 crackle | longer, denser | AD(30, 620), rate U(0.8, 1.25) |
| L6 expansion | new | white noise, bandpass rising 900 → 1 500 Hz over 120 ms Q 1.2, AD(6, 140), gain 0.14 |
| L7 debris | new | 8–14 grains `struck[U(600,5200) Hz, Q U(8,26), g U(0.02,0.07), decay U(10,80) ms]` over `t0 + U(40,520)` ms |
| L8 settle | new | pink noise, lowpass swept 1 400 → 320 Hz, AD(120, 700), gain 0.14 |

Duck: `ambience` −7 dB, `music` −3 dB, 15 ms attack, 200 ms hold, 450 ms release.
Length 1 100 ms. Send 0.60. 28 nodes.

---

#### R11 — `meteor.telegraph` + `meteor.impact`

**Telegraph** — 1 200 ms, fires on `skill:cast`, positioned at the impact point
on a **tracked** emitter whose Y is animated from 14 m down to 0 over the last
500 ms. The descent is the whole reason it works: the pan stays put while the
sound gets closer, which is unmistakable.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| whistle | sawtooth | bandpass swept 2 600 → 420 Hz over 1 150 ms, Q 6.0 | attack 200 ms → 0.18, hold, decay 120 ms | 0.18 |
| pressure | brown noise | lowpass 180 Hz | linear ramp 0 → 0.30 over 1 100 ms | 0.30 |

**Impact** —

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 sub | sine, sweep 72 → 24 Hz over 420 ms | `tanh` drive 5 | AD(4, 460) | 1.15 |
| L2 blast | brown noise | lowpass swept 6 500 → 240 Hz over 520 ms → `tanh` drive 6 | AD(8, 540) | 0.90 |
| L3 crack | white noise | highpass 2 200 Hz → `tanh` drive 12 | HIT(22) | 0.70 |
| L4 debris | 18–26 grains | `struck[U(400,6000) Hz, Q U(8,30), g U(0.02,0.08), decay U(10,110) ms]` over `t0 + U(40,900)` ms | — | — |
| L5 pool | `crackle` | bandpass 1 400 Hz Q 0.9 | attack 300 ms, then hands off to `firepool.loop` | 0.14 |

Duck: `ambience` −9 dB, `music` −5 dB, `sfx` −3 dB, 20 ms attack, 350 ms hold,
600 ms release. Randomised: L1 start ± 1 st; grain count and placement; decays
× U(0.9, 1.15). Length 1 600 ms. Send 0.85. 38 nodes.

---

#### R12 — `lightning.arc`

Lightning that is not instant reads as a firework. L1's 10–90% rise time must
measure ≤ 1.2 ms — this is a gated acceptance criterion (§9 step 8).

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 snap | white noise | highpass U(4 600, 5 900) Hz → `tanh` drive 14 asym 0.7 | HIT(4) | 0.90 |
| L2 ionise | white noise | bandpass swept **upward** 900 → U(4 800, 6 200) Hz over 26 ms, Q 4.5 | AD(0.8, 40) | 0.55 |
| L3 body | 2 squares at 128 Hz and 128 + U(2.4, 4.1) Hz | lowpass swept 3 200 → 700 Hz over 90 ms, Q 4.0; ring-modulated by a U(41, 57) Hz sine via a multiplier gain | AD(1, 110) | 0.30 |
| L4 sizzle | white noise, amplitude-gated by a 63 Hz square | bandpass 7 400 Hz Q 1.4 | AD(12, 260) | 0.14 |

The upward sweep in L2 is unusual — almost every other transient in the game
sweeps down — and it is exactly why lightning is instantly identifiable in a
crowded mix.

Chain jumps re-trigger **L1 and L2 only**, at `t0 + 55 ms` and `t0 + 110 ms`, at
0.70× and 0.50× gain, pitched +2 and +4 st, positioned on the respective target.

**Send 0.30.** A wet lightning sounds distant, and Discharge is a point-blank
skill. Length 340 ms. 16 nodes.

---

#### R13 — `ice.impact` and `frozen.shatter`

**`ice.impact`** — the partial ratios are deliberately *inharmonic*
(1 : 1.584 : 2.673 : 4.173) so it reads as crystal rather than as a bell. That
distinction matters because the unique-drop bell (R22) is harmonic, and the two
must never be confusable.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 crystal | 2 ms white burst | `struck[2140 Q40 g0.35 d260; 3390 Q32 g0.24 d170; 5720 Q24 g0.15 d95; 8930 Q16 g0.07 d50]` | — | — |
| L2 FM glass | sine carrier 1 870 Hz; modulator sine at 4 507 Hz (ratio 2.41) into `carrier.frequency` | — | modulator gain swept 620 → 40 Hz over 120 ms; carrier AD(1, 180) | 0.22 |
| L3 frost | white noise | highpass 6 200 Hz | AD(8, 300) | 0.16 |
| L4 sub | sine, sweep 130 → 70 Hz | — | AD(2, 90) | 0.22 |

Length 420 ms. Send 0.50. 17 nodes.

**`frozen.shatter`** — L1 at 1.3× gain, plus 22–30 crystalline grains
`struck[U(1800,12000) Hz, Q U(24,48), g U(0.015,0.05), decay U(15,90) ms]`
scattered over `t0 + U(0,420)` ms, plus a 60 → 28 Hz sub AD(2, 200) at gain 0.5.
Length 900 ms. Send 0.65. 34 nodes.

---

#### R14 — `ashstep.out` / `ashstep.in`

Two halves, 40 ms apart. Leaving **falls**, arriving **rises** — an exact
mirror, and it is what makes an 8 m blink legible as a single gesture.

**OUT**, at the origin:

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| collapse | white + pink noise | bandpass swept 3 400 → 480 Hz over 180 ms, Q 2.2 | AD(2, 200) | 0.42 |
| thump | sine, sweep 210 → 90 Hz | — | AD(1, 80) | 0.30 |

**IN**, at the destination, `t0 + U(30, 55)` ms:

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| arrival | white + pink noise | bandpass swept 380 → 2 900 Hz over 130 ms, Q 2.2 | AD(6, 160) | 0.38 |
| cloud | brown noise | lowpass 900 Hz, cutoff modulated by a 2.4 Hz sine ±80 Hz | AD(40, 620) | 0.22 |

Randomised: sweep endpoints ± 15%; gap `U(30, 55)` ms; cloud LFO rate
U(2.0, 2.9) Hz. Combined length 800 ms. Send 0.40. 21 nodes total.

---

#### R15 — `embershield.break`

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 fracture | 2 ms white burst | `struck[1640 Q36 g0.40 d180; 2710 Q28 g0.30 d120; 4380 Q22 g0.20 d70; 6950 Q16 g0.10 d40]` | — | — |
| L2 release | white noise | highpass swept 400 → 5 200 Hz over 90 ms | AD(1, 140) | 0.50 |
| L3 pop | sine, sweep 96 → 40 Hz over 110 ms | `tanh` drive 4 | AD(1.5, 130) | 0.60 |
| L4 shards | 12–18 grains | `struck[U(2400,10500) Hz, Q U(26,44), g U(0.015,0.045), decay U(10,60) ms]` over `t0 + U(30,420)` ms | — | — |
| L5 embers | `crackle` | bandpass 3 100 Hz Q 1.1 | AD(20, 520) | 0.18 |

L2's **upward** highpass sweep is the "pressure escaping" cue and is what stops
this sounding like a window breaking. Duck: `ambience` −6 dB, 180 ms hold.
Length 900 ms. Send 0.55. 26 nodes.

---

#### R16 — `resonance.discharge`

The only pitched combat sound in the game. Resonance is the one mechanic that
"sings", so this sound is locked to the music root — **D2 = 73.42 Hz** — and is
the **least randomised** sound in the catalogue.

| layer | content | envelope | gain |
|---|---|---|---|
| L1 charge bank | already running from `resonance.charge`: 5 sines at 73.42 × {1,2,3,4,5} Hz | pips faded in over 120 ms each | 0.30 / 0.20 / 0.12 / 0.07 / 0.04 |
| L2 release | the same 5 partials swept **+7 st** (× 1.4983) over 180 ms; a lowpass Q 1.0 opens 6 000 → 14 000 Hz over 200 ms | AD(6, 620) | 0.55 |
| L3 strike | `melee.hit.metal` layered at 1.2× | — | — |
| L4 spill | `lightning.arc` L1 + L4 at 0.60×, at `t0 + 25 ms` | — | — |
| L5 sub | sine 73.42 → 36.71 Hz over 300 ms | AD(3, 340) | 0.70 |

Duck: `music` −6 dB, 700 ms — so the discharge is heard *inside* the score, not
over it. Randomised: **± 0.4 st detune per partial and ± 8% on gains, nothing
else.** Its pitch stability is the point; a Runeblade player learns to hear a
full stack. Length 1 100 ms. Send 0.45. 30 nodes.

---

#### R17 — `mob.ranker.death`

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 voice | sawtooth, f0 U(132, 168) Hz falling to 62 Hz over 340 ms | 3 parallel bandpasses at 620 / 1 240 / 2 380 Hz, Q 6 / 8 / 9, gains 1.0 / 0.50 / 0.22 → `tanh` drive 1.8 | ADSR(12, 60, 180, 0.55, 240) | 0.50 |
| — tremolo | U(16, 23) Hz sine, ±30% on the output gain | — | — | — |
| L2 collapse | 9–14 grains | `struck[U(420,3200) Hz, Q U(10,26), g U(0.03,0.09), decay U(20,110) ms]` over `t0 + U(120,620)` ms | — | — |
| L3 bodyfall | sine 82 → 44 Hz over 120 ms, `tanh` drive 2.2 | — | AD(4, 140) at `t0 + U(180,300)` ms | 0.50 |
| L4 dust | brown noise | lowpass swept 700 → 260 Hz | AD(30, 420) | 0.14 |

**Per-instance identity**: the formant set is scaled by a "tract length"
`U(0.93, 1.08)` derived deterministically from `opts.seedHint` (the actor id), so
the same Ranker always sounds like itself across its idle, hurt and death.

Length 1 000 ms. Send 0.40. 26 nodes.

---

#### R18 — `mob.swarm.attack`

A swarm attack is 3–6 micro-bites, never one bite. This is also the single
biggest machine-gun risk in the game (6–10 monsters, all attacking): coalescing
window 90 ms, cap 4 concurrent, and at ≥ 4 pending in a window the grain counts
**merge into one voice** with `n` up to 12.

| layer | content |
|---|---|
| L1 bite grains | `n = 3 + ⌊U(0,4)⌋`, at `t0 + i · U(14, 38)` ms. Each: a 1.5 ms white burst → bandpass U(1 800, 4 600) Hz Q U(3, 7), HIT(U(6,18) ms), gain U(0.10, 0.22); plus a paired `struck[0.6 × f, Q 14, g 0.5 × burst, decay U(15,40) ms]` |
| L2 chitter | 2 squares at U(880, 1 240) Hz and × 1.5, gated by a 34 Hz square multiplier, bandpass 2 400 Hz Q 3.5, AD(8, 90), gain 0.16 |
| L3 wet | pink noise, bandpass swept 400 → 1 100 Hz Q 2.0, AD(4, 70), gain 0.18 |

The 34 Hz gate on L2 is the swarm's signature — it turns a tone into a stutter,
and the stutter is what your ear counts as "many". Length 240 ms. Send 0.22.
15 nodes.

---

#### R19 — `mob.maulsmith.windup` + `mob.maulsmith.slam`

The telegraph is **audible** as well as visible. That is what makes the 1.2 s
dodge window fair when the Maulsmith is at the edge of the screen.

**Windup**, 1 200 ms:

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| strain | brown noise | bandpass rising 90 → 260 Hz over 1 000 ms, Q 1.6 | linear 0 → 0.28 | 0.28 |
| armour | 3 clanks at 0 / 380 / 760 ms | `struck[380 Q14 g0.12 d90; 840 Q14 g0.08 d70; 1720 Q14 g0.04 d45]` each | — | — |

**Slam**:

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 sub | sine 58 → 22 Hz over 380 ms | `tanh` drive 6 asym 0.65 → lowpass 180 Hz Q 0.8 | AD(3, 420) | 1.20 |
| L2 ground | brown noise | lowpass swept 2 400 → 190 Hz over 300 ms → `tanh` drive 5 | AD(6, 330) | 0.80 |
| L3 head | 3 ms white burst | `struck[240 Q12 g0.40 d180; 520 Q16 g0.26 d110; 1180 Q20 g0.12 d60]` | — | — |
| L4 debris | 10–16 grains | `struck[U(500,4200) Hz, Q U(8,26), g U(0.02,0.07), decay U(12,90) ms]` over `t0 + U(30,600)` ms | — | — |

Duck: `ambience` −5 dB, `music` −3 dB, 220 ms hold. Randomised: L1 start
U(54, 63) Hz; decays × U(0.90, 1.15); head partials ± 2 st. Length 1 200 ms.
Send 0.70. 30 nodes (slam) + 14 (windup).

---

#### R20 — `mob.crawler.death`

The only monster whose death is louder than its attack, and the only one with no
metal anywhere in its spectrum.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 rupture | white noise | bandpass swept 320 → 1 900 Hz over 70 ms Q 1.8 → `tanh` drive 3.5 | AD(1, 90) | 0.70 |
| L2 pressure | pink noise | lowpass swept 3 200 → 380 Hz over 620 ms | AD(6, 680) | 0.55 |
| L3 splatter | 6–10 grains, tuned *wet* | bandpass U(180, 900) Hz Q U(2, 5), decay U(30,120) ms, gain U(0.05, 0.13), over `t0 + U(40,420)` ms | — | — |
| L4 gas | white noise | bandpass 4 600 Hz Q 0.9 | ramp 0 → 0.14 over 200 ms, then hands off to `poison.cloud.loop` | 0.14 |
| L5 burp | sine 88 → 38 Hz over 180 ms | — | AD(2, 200) | 0.45 |

L3's low, wide, low-Q grains are the reason this reads as *wet* — the same grain
generator with Q 30 and 4 kHz centres would read as glass.

Length 900 ms. Send 0.50. 24 nodes.

---

#### R21 — `boss.p2.transition` (Molgrim's phase roar)

The longest single voice in the game and the one moment where the boss owns the
entire mix.

| layer | content | envelope | gain |
|---|---|---|---|
| L1 larynx | 2 glottal oscillators at f0 = 62 Hz and 62 × 1.008 (beating), through 4 formants at 310 / 690 / 1 420 / 2 600 Hz, Q 5 / 7 / 8 / 9, gains 1.0 / 0.62 / 0.30 / 0.14 → `tanh` drive 2.6. f0 contour 62 → 78 Hz over 700 ms, then → 54 Hz over 1 500 ms. Tremolo 7.5 Hz depth 0.22. | ADSR(90, 260, 1 200, 0.70, 900) | 0.70 |
| L2 sub-harmonic | sine at f0 / 2 = 31 Hz | follows L1 | 0.50 |
| L3 gravel | white noise **ring-modulated by the f0 oscillator** (multiplier gain), bandpass 1 100 Hz Q 1.4 | AD(60, 1 800) | 0.32 |
| L4 stone | brown noise, bandpass 180 → 420 → 150 Hz Q 3.5 | AD(200, 2 200) | 0.20 |
| L5 choir | 4 sines D2 / A2 / D3 / F3 = 73.42 / 110.00 / 146.83 / 174.61 Hz | attack 400 ms, release 1 400 ms | 0.10 / 0.08 / 0.06 / 0.05 |

L3's ring modulation locks the noise to the pitch, which the ear reads as a torn
throat rather than as noise added to a tone — that is the whole trick.
L5 is the "ash and forgotten knowledge" tell and it locks Molgrim to the zone
key, so the roar is always consonant with the music underneath it.

Duck: `ambience` −16 dB, `music` −20 dB, `sfx` −6 dB, `voice` 0 dB; 40 ms
attack, 2 600 ms hold, 800 ms release.

Randomised: **± 1.5% on f0 and ± 4% on the formants, nothing else.** The boss
must be recognisable. `boss.p3.transition` is the same recipe with f0 = 54 Hz,
the choir shifted to D / A♭ / D (the tritone), and L3 at 1.4×.

Length 3 400 ms. Send 0.75. 34 nodes.

---

#### R22 — `item.drop.unique` — the marquee sound

Design brief: recognisable through a wall of combat, from anywhere on screen and
beyond, and the **only** sound in the game that uses this timbre. It is a bell,
and it arrives with an inhale.

**Stage 1 — anticipation (0–180 ms).** Pink noise, bandpass swept
900 → 4 200 Hz Q 3.0, gain ramping 0 → 0.20 over 170 ms (attack 170 ms). The
duck is applied at `t0`, so the world drops *before* the bell strikes.

**Stage 2 — strike (at 180 ms).** A struck bell on **f0 = 293.66 Hz (D4)** with
classic bell ratios:

| ratio | frequency | Q | gain | decay |
|---|---|---|---|---|
| 0.50 (hum) | 146.83 Hz | 60 | 0.32 | 1 900 ms |
| 1.00 (prime) | 293.66 Hz | 54 | 0.44 | 1 750 ms |
| 1.19 (tierce) | 349.5 Hz | 46 | 0.26 | 1 200 ms |
| 1.56 (quint) | 458.1 Hz | 40 | 0.20 | 950 ms |
| 2.00 (nominal) | 587.3 Hz | 34 | 0.16 | 700 ms |
| 2.66 | 781.1 Hz | 26 | 0.10 | 430 ms |
| 3.01 | 883.9 Hz | 20 | 0.06 | 280 ms |

Excitation: a 2.2 ms white burst. **The hum note an octave below the strike note
is what makes a bell a bell**, and it is the partial that still carries at 60 m.

**Stage 3 — glow (from 260 ms).** 3 sines at 587.3 / 880.0 / 1 174.7 Hz
(D5 / A5 / D6), attack 24 ms, sustained at 0.055 / 0.040 / 0.028, released over
1 400 ms, with a 4.6 Hz vibrato of ± 6 cents on the upper two. Keeps the tail
alive without adding loudness.

**Stage 4 — gold dust (300–1 500 ms).** 9–13 grains
`struck[U(3800,12000) Hz, Q U(30,55), g U(0.012,0.03), decay U(20,90) ms]`.
Sparse, high, quiet.

| property | value | why |
|---|---|---|
| send | **0.95** | the wettest sound in the game; the wetness is half the "this is special" read |
| duck | `ambience` −14, `music` −10, `sfx` −5, `voice` −6 dB; 25 ms / 300 ms / 900 ms | |
| attenuation | refDist 8 m, rolloff 0.22, maxDist 60 m (−7.7 dB at the far edge) | audible from anywhere you could plausibly be |
| priority | **1.00** — never stolen, never coalesced, never rate-limited, never degraded | |
| randomisation | f0 ± 0.3%; grain count and placement. **Nothing else.** | a player must learn it in one session |

Length 2 400 ms. **55 nodes** — the most expensive voice in the game, and worth
it: it fires a handful of times per run.

---

#### R23 — `player.footstep.ash`

The signature surface of the game. Head-locked (no panner, no distance, no
delay). Two contacts at 0 and `U(14, 30)` ms, second at 0.45× gain.

| layer | source | filter | envelope | gain |
|---|---|---|---|---|
| L1 compression | brown noise | lowpass swept 620 → 180 Hz over 90 ms, Q 0.7 | AD(2, 110) | 0.42 |
| L2 powder | white noise | bandpass swept 1 450 → 720 Hz over 150 ms, **Q 0.45** (very wide — ash is broadband and soft) | AD(3, 170) | 0.50 |
| L3 puff | white noise | lowpass 900 Hz | AD(45, 260) at `t0 + U(60,110)` ms | 0.13 |
| L4 body | sine 74 → 44 Hz | — | AD(2.5, 60) | 0.28 |

**No grit grains.** Ash has no hard particles, and that absence is precisely
what separates it from `dirt` and `sand` by ear. Randomised: all centres ± 3 st;
decays × U(0.85, 1.20); level × U(0.90, 1.10). Length 340 ms. Send 0.25.
12 nodes.

---

#### R24 — `player.lowlife.heartbeat`

| layer | content | envelope | gain |
|---|---|---|---|
| S1 | sine 62 → 38 Hz over 105 ms | AD(6, 120) | 0.62 |
| S1 valve | sine 118 Hz | AD(4, 70) | 0.18 |
| S2 (at +175 ms) | sine 54 → 34 Hz over 95 ms | AD(5, 95) | 0.40 |
| rush | pink noise, lowpass 260 Hz | AD(40, 420), tied to S1 | 0.09 |

Rate: `interval = 900 − 480 · (1 − life / 0.25·maxLife)` ms, clamped to
[420, 900] — 900 ms at exactly 25% life, 420 ms at 1%. Head-locked, `ui` bus, no
reverb send. Length 620 ms. 10 nodes.

**How it cuts through a busy mix.** It does *not* get louder. Three mechanisms:

1. **Routing.** It is on `ui`, which joins at `masterSum` after `worldGain` and
   `pauseLP`. No duck rule targets `ui`. A boss roar, a Meteor and the pause
   filter all leave it untouched.
2. **Reverse sidechain.** Every S1 ducks the `sfx` bus by **2.5 dB** with a
   20 ms attack, 60 ms hold and 180 ms release, and `music` by 1.5 dB. The mix
   breathes with the player's pulse. Nobody consciously hears the duck;
   everybody hears the heartbeat.
3. **A reserved band.** All of its energy is below 130 Hz. While the heartbeat
   is active, the `sfx` bus highpass moves from 28 Hz to **62 Hz** (12 dB/oct,
   400 ms time constant), clearing 40–90 Hz of everything else. Nothing in the
   game occupies that band *continuously* — the crit sub, the Maulsmith slam and the
   Meteor are all transient — so the cost is a slight thinning of impacts and the
   benefit is a warning you cannot miss. One biquad, always present, only moved.

---

#### R25 — `player.levelup`

Key-locked to D minor. Deliberately **not randomised** — progression sounds must
be identical every time or they stop functioning as landmarks.

| layer | content | envelope | gain |
|---|---|---|---|
| L1 arpeggio | 3 triangles at 293.66 / 440.00 / 587.33 Hz (D4 / A4 / D5), onsets 0 / 110 / 220 ms, through a lowpass 5 200 Hz Q 0.8 | AD(8, 620) each | 0.22 / 0.20 / 0.24 |
| L2 swell | pink noise, bandpass swept 400 → 3 200 Hz over 700 ms Q 1.6 | attack 620 ms → 0.16, decay 400 ms | 0.16 |
| L3 sub | sine 73.42 Hz | attack 40 ms, decay 900 ms | 0.35 |
| L4 shimmer | 6 grains `struck[U(4000,11000) Hz, Q U(30,50), g U(0.01,0.025), decay U(30,90) ms]` over `t0 + U(200,900)` ms | — | — |

Head-locked, `ui` bus. Duck: `ambience` −10 dB, `music` −8 dB, `sfx` −4 dB,
30 ms / 400 ms / 800 ms. Send 0.50. Length 1 600 ms. 22 nodes. Randomised: grain
placement only.

---

#### R26 — `ui.click`

| layer | content | envelope | gain |
|---|---|---|---|
| L1 | 2.2 ms white burst → bandpass 3 200 Hz Q 2.2 | HIT(18) | 0.35 |
| L2 | `struck[1850, Q 26, decay 22 ms]` | — | 0.18 |
| L3 | `struck[4600, Q 34, decay 11 ms]` | — | 0.07 |

34 ms total, no reverb send, `ui` bus, 6 nodes. Randomised: centre ± 1 st only.
`ui.hover` is L2 alone at 0.35× and 14 ms. `ui.error` swaps all of it for two
squares at 220 and 233 Hz (a minor second) through a lowpass at 1 800 Hz,
AD(3, 180), gain 0.30 — the only deliberately dissonant UI sound.

---

## 6. Music

**Yes, there is music, and it is a five-layer generative bed, not a score.**

A written score would loop, and a looping 90-second theme in a game where a run
lasts 25 minutes is worse than silence. A generative bed can run for an hour
without repeating, react to combat continuously, and cost 40 nodes.

### 6.1 Tonal system

| property | value |
|---|---|
| root | **D**, `D2 = 73.42 Hz` |
| mode (town, Wastes) | D Aeolian — D E F G A B♭ C |
| mode (Bonereach) | **D Phrygian** — D E♭ F G A B♭ C (one note changed, and it is enough to make the dungeon feel wrong) |
| mode (Altar, phase 3 only) | D Aeolian with an added A♭ (207.65 Hz) tritone in the pad |
| tempo | 72 BPM exploring, 96 BPM in combat |
| beat | 833.3 ms @ 72, 625.0 ms @ 96 |

**Every pitched sound in the game is locked to this root.** The unique-drop bell
is D4. The level-up arpeggio is D–A–D. The Resonance discharge is D2. Molgrim's
choir is D–A–D–F. A drop landing during a boss roar is consonant with it, always.

### 6.2 Layers

| layer | content | scheduling | gain @ I=0 | @ I=0.5 | @ I=1.0 |
|---|---|---|---|---|---|
| `drone` | 2 sines 36.71 / 73.42 Hz + 1 sawtooth 110 Hz through a lowpass 320 Hz; LFOs 0.031 / 0.047 / 0.019 Hz, ±25% on gain | continuous | 0.55 | 0.75 | 0.85 |
| `pad` | 4 sawtooths D3/F3/A3/C4 (146.83 / 174.61 / 220.00 / 261.63 Hz), ±7 cents, lowpass Q 1.2 with cutoff following `I`: 620 → 1 900 Hz | continuous | 0.35 | 0.50 | 0.55 |
| `pulse` | brown noise bandpass 180 Hz Q 2.2, AD(90, 620); every 2 beats | scheduled | 0.00 | 0.35 | 0.55 |
| `lead` | triangle, one note per 2 bars drawn from {D, F, G, A, C} by a deterministic weighted walk, AD(240, 1 800), lowpass 2 400 Hz | scheduled | 0.22 | 0.14 | **0.00** |
| `perc` | sine 82 → 48 Hz AD(2, 180) + `struck[190 Q8; 420 Q8; 860 Q8]`; beats 1 and 3 | scheduled | 0.00 | 0.20 | 0.45 |

The lead goes **silent in combat**. A melody competing with 25 monsters is
information the player cannot use, and removing it is what makes the drone and
the pulse audible instead.

### 6.3 Combat intensity

```
I_raw = clamp( 0.12 · hostilesWithin24m
             + 0.50 · (bossActive ? 1 : 0)
             + 0.35 · (1 − life / maxLife) , 0, 1 )
```

Computed **once per second in `fixedUpdate`** — it reads only simulation state,
never wall-clock, so it is deterministic. Smoothed with a one-pole: 3.5 s time
constant rising, 8.0 s falling. Combat should arrive quickly and leave slowly.

All layer gains follow with `setTargetAtTime(target, t, 2.5)`. The tempo change
(72 → 96 BPM) is applied to the `pulse` and `perc` periods at the next bar
boundary, never mid-bar.

### 6.4 Scheduling

A lookahead scheduler runs in `update()` on the main thread and schedules
everything due in the next **250 ms**:

```js
while (nextNoteTime < actx.currentTime + 0.25) {
  scheduleNote(nextNoteTime);
  nextNoteTime += beat * beatsPerNote;   // deterministic accumulator
}
```

No `setTimeout`, no `Date.now()`. The music RNG is its own `fork()` and the
scheduler never runs in `fixedUpdate`, so it can never perturb gameplay.

### 6.5 CPU budget

| item | nodes | cost |
|---|---|---|
| drone | 13 | 0.6% |
| pad | 6 | 0.5% |
| pulse (1 live voice) | 6 | 0.4% |
| lead (1 live voice) | 4 | 0.2% |
| perc (1 live voice) | 9 | 0.5% |
| bus + pause filter | 2 | 0.1% |
| **total** | **≤ 40 (24 always on)** | **≤ 2.3% of one audio-thread core** |

Main-thread cost of the scheduler: **≤ 0.05 ms per frame** (a `while` loop that
runs zero or one iterations at 60 fps).

---

## 7. Mix

### 7.1 Category levels

"Peak" is the category's typical peak measured at `masterSum`, before `preGain`,
with the source at its reference distance. These are targets for the offline
bench (§9 step 13), not aspirations.

| category | bus | peak | duck rank | rationale |
|---|---|---|---|---|
| **item drop, unique** | sfx | **−3 dB** | **1** | The loudest non-boss event in the game. It is the payoff the entire loot system exists to deliver. |
| boss voice / phase roar | voice | −2 dB | **1** | Ducks everything, is ducked by nothing. |
| player crit | sfx | −5 dB | 2 | +3 dB over a normal hit *is* the reward. |
| meteor / fireball / big AoE | sfx | −4 dB | 2 | The player's own biggest verbs. |
| level-up / quest complete | ui | −6 dB | 1 | Progression landmarks, and rare. |
| player melee / spell impact | sfx | −8 / −7 dB | 3 | The metronome of the game; the loudest *routine* event. |
| item drop, rare | sfx | −9 dB | 4 | |
| monster voice (unique, champion) | voice | −10 dB | 4 | |
| low-life heartbeat | ui | −11 dB | **0** | Ducks others; nothing ducks it. See R24. |
| monster death | sfx | −12 dB | 4 | 4 dB above hurt, because deaths are rewards. |
| item drop, magic | sfx | −12 dB | 4 | |
| monster attack | sfx | −13 dB | 5 | Twelve at once must sum to less than one player hit. |
| item drop, normal / superior | sfx | −14 dB | 5 | |
| pickup / equip / vendor | sfx | −14 dB | 5 | |
| UI clicks and panels | ui | −15 dB | — | Never ducked, but quiet enough to live under everything. |
| monster hurt | sfx | −16 dB | 6 | |
| gold | sfx | −17 dB | 7 | Coalesced hard; a pile is one sound. |
| surface impact | sfx | −18 dB | 6 | |
| player footstep | sfx | −20 dB | 7 | Present, never in the way. |
| music | music | −21 dB | 9 | |
| ambience one-shot | ambience | −22 dB | 9 | |
| monster idle / aggro | sfx | −24 dB | 8 | |
| monster footstep | sfx | −26 dB | 9 | |
| ambience bed | ambience | −27 dB | 10 | Should be noticed only when it stops. |

Integrated loudness target for a dense combat scene: **−23 LUFS ± 1.5**, true
peak **≤ −1.0 dBTP**.

### 7.2 Duck rules

| rule | ambience | music | sfx | voice | attack | hold | release |
|---|---|---|---|---|---|---|---|
| `unique-drop` | −14 dB | −10 dB | −5 dB | −6 dB | 25 ms | 300 ms | 900 ms |
| `levelup` | −10 | −8 | −4 | −4 | 30 ms | 400 ms | 800 ms |
| `quest-complete` | −10 | −8 | −4 | −4 | 30 ms | 500 ms | 900 ms |
| `boss-roar` | −16 | −20 | −6 | 0 | 40 ms | 2 600 ms | 800 ms |
| `boss-death` | −20 | −24 | −8 | 0 | 40 ms | 3 000 ms | 2 000 ms |
| `player-death` | −18 | −6 | −12 | −12 | 60 ms | 1 200 ms | 2 500 ms |
| `big-aoe` (meteor, rupture, fireball) | −7 | −3 | 0 | −3 | 15 ms | 200 ms | 450 ms |
| `crit` | 0 | 0 | −3 | 0 | 25 ms | 120 ms | 260 ms |
| `heartbeat` (per S1) | 0 | −1.5 | −2.5 | 0 | 20 ms | 60 ms | 180 ms |
| `portal-travel` | −18 | −8 | −18 | −18 | 40 ms | 400 ms | 700 ms |
| `pause` | −9 + LP 900 Hz | 0 | −9 + LP 900 Hz | −9 | 80 ms | until resume | 220 ms |

`ui` never appears as a target in any row. That is the design, not an omission.

Deepest active duck wins per bus; a shallower rule arriving during a deeper
hold is discarded.

### 7.3 Frequency allocation

The mix is also planned in the frequency domain, because in a game with 25
simultaneous sources level alone cannot keep things separated.

| band | primary occupant | kept clear of |
|---|---|---|
| 20–40 Hz | Meteor sub, Maulsmith slam, boss sub-harmonic | everything else (`sfx` highpass at 28 Hz) |
| 40–90 Hz | **low-life heartbeat (reserved)** | `sfx` highpass moves to 62 Hz when active |
| 90–200 Hz | melee bodies, drops, music drone | monster idles are highpassed at 180 Hz |
| 200–800 Hz | monster voices, flesh/stone impacts, music pad | |
| 800–2 500 Hz | melee textures, spell bodies, UI | the reverb send is highpassed at 180 Hz so the tail never crowds this |
| 2 500–6 000 Hz | metal ring, bone crack, item pings | ambience beds are lowpassed here |
| 6 000–12 000 Hz | lightning snap, ice, gold dust, unique-drop shimmer | ambience contributes nothing above 6 kHz |

---

## 8. Performance

### 8.1 Two budgets

Web Audio renders on its own thread. The audio graph does **not** consume
main-thread frame time; only the JS that builds and schedules it does. These are
separate budgets and must be measured separately.

| budget | limit | measured by |
|---|---|---|
| **audio thread** | ≤ 35% of one core sustained, ≤ 60% peak (a 128-sample quantum must render in ≤ 0.93 ms of the 2.67 ms available at 48 kHz) | `AudioContext.renderCapacity` where available; offline render wall-time ÷ rendered duration otherwise |
| **main thread** | ≤ **0.8 ms per 16.7 ms frame** (5%) for event handling, node construction, listener update and emitter teardown | `tools/profile.mjs` attribution |

Sustained 35% on the audio thread with 60% peaks leaves the headroom that
prevents dropouts; above roughly 80% Chromium starts producing audible glitches
and there is no graceful recovery.

Breakdown of the 35%:

| item | budget |
|---|---|
| reverb (1–2 convolvers) | 7.2% |
| 48 spatial emitters (equal-power) | 2.0% |
| bus and master compressors (5 nodes) | 3.5% |
| ambience bed (3 layers + LFOs) | 4.0% |
| music (5 layers) | 2.3% |
| transient voices (typical dense combat) | 12.0% |
| headroom | 4.0% |

### 8.2 Node ceilings

| stage | nodes |
|---|---|
| master chain (`masterSum`, `preGain`, `masterComp`, `softClip`, `masterGain`, `worldSum`, `pauseLP`, `worldGain`) | 8 |
| buses (sfx 5, voice 4, ambience 4, music 4, ui 3) | 20 |
| reverb (send, sendHP, sendLP, return, 6 × convolver, 6 × gain) | 16 allocated / 8 active |
| spatial emitter pool (48 × 6) | 288 |
| head-locked pool (16 × 2) | 32 |
| ambience bed (per zone) | ≤ 40 |
| music | ≤ 40 |
| **static total** | **444** |
| transient voice nodes (48 concurrent × 14 average) | ≤ 672 |
| **hard ceiling** | **1 200 live `AudioNode`s** |

Typical measured during dense combat (18 monsters, 3 skills active): **420–650**.
`report().nodes` tracks this and the dev overlay shows it; exceeding 1 200 is a
bug, not a degradation.

Per-voice node counts range from 4 (`dot.poison.tick`) to 55 (`drop.unique`),
mean 14.

### 8.3 Built at boot vs created per shot

**Built once, on the first gesture (≈ 40 ms of main thread, behind the class
select screen):**

| item | cost | memory |
|---|---|---|
| noise bank: white / pink / brown / crackle, 2 channels × 2.4 s @ 48 kHz | 24 ms | 3.69 MB |
| static graph (444 nodes) | 4 ms | — |
| current zone's IR | ≤ 6.6 ms | ≤ 1.23 MB |
| round-robin timbre tables (263 ids × 6 slots, plain objects) | 2 ms | ~0.4 MB |
| ambience bed + music | 5 ms | — |

Remaining IRs render on `requestIdleCallback` or on `zone:enter` behind the
transition fade. Total audio buffer memory for a session: **≈ 8.5 MB**.

**Created per shot:** every voice's oscillators, filters and gains. Web Audio
gives no way to pool an `OscillatorNode` (single-use by specification), so this
is unavoidable. The mitigations are the voice caps, the coalescing rules, the
per-frame acquisition budget of 6, and the fact that **a refused sound allocates
nothing at all** — the check happens before `_build`.

Nothing is ever generated during play: **no IR, no noise buffer and no
round-robin table is built while a zone is active.** This is a gated acceptance
criterion (§9 step 14).

### 8.4 Garbage collection

- **No allocation in `update()` or `fixedUpdate()`.** Scratch vectors, the
  emitter records, per-category counters, the coalescing table (a fixed-size
  `Map` seeded with all 263 ids at boot) and the mass-death accumulator are all
  preallocated in `init()`.
- Event payloads are read and discarded, never retained. `audio` holds no
  reference to any actor, item or skill object beyond the duration of the
  handler.
- The one unavoidable allocation is each voice's `{ node, end, send }` return
  object — three properties, ~40 per second at peak. We deliberately do **not**
  pool it: pooling three-field objects costs more in bookkeeping than the
  nursery costs in collection.
- **The real leak risk is a voice whose nodes stay connected.** A connected
  subgraph keeps every node in it alive forever. The emitter sweep in `update()`
  disconnects every voice whose scheduled `end` has passed, and it runs
  **before** the `actx.state === 'suspended'` early-out, so a backgrounded tab
  does not accumulate orphans.

### 8.5 Degradation ladder

Load estimate: `L = 0.6 · (activeVoices / poolSize) + 0.4 · renderCapacity`,
smoothed over 30 frames.

| L | action |
|---|---|
| > 0.70 | monster idle/aggro sounds stop being scheduled; ambience one-shot rate halves |
| > 0.78 | monster footsteps stop; all debris/grain counts × 0.5 |
| > 0.85 | the second reverb convolver is dropped mid-crossfade (snap to the target IR); reverb sends on impact-class voices × 0.5 |
| > 0.90 | all coalescing windows × 2; monster hurt cap 8 → 4 |
| > 0.95 | only voices with priority ≥ 0.70 are built at all — player actions, deaths, boss, items, UI |
| — | **never degraded, at any load:** the low-life heartbeat, `drop.unique`, boss voices, the UI bus |

Quality presets (`config.q.audio`):

| preset | emitters | dry slots | convolvers | altar IR | music perc | grains |
|---|---|---|---|---|---|---|
| low | 24 | 12 | 1 | 1.8 s | off | × 0.5 |
| medium | 32 | 16 | 1 | 2.4 s | on | × 0.75 |
| high | 48 | 16 | 2 | 3.2 s | on | × 1.0 |
| ultra | 64 | 24 | 2 | 3.2 s | on | × 1.5 |

---

## 9. Implementation order

Fifteen steps. Each is independently verifiable and each has a gate. Do not
start step *n+1* until step *n*'s gate passes.

### How to audition without launching the game

Two tools, both of which must exist before step 6.

**`src/audio/selftest.js`** — renders every catalogue id through the *real*
mixer graph in an `OfflineAudioContext(2, N, 48000)` and measures the master
output. `OfflineAudioContext` needs no user gesture and no speaker, which is the
whole reason the audio subsystem can be verified headlessly at all. Per case it
reports:

| metric | meaning | gate |
|---|---|---|
| `peak` | absolute sample peak | < 1.0 (≥ 1.0 means the limiter failed) |
| `rms` | loudness | > 2 × 10⁻⁵ (0 means the voice is silent — a bug) |
| `dc` | mean sample value | \|dc\| < 0.02 (a large offset means an envelope never closed) |
| `nan` | non-finite samples | 0 (bad `exponentialRamp` targets, division by zero) |
| `centroid` | spectral centre via zero-crossing rate, Hz | within the family's declared band |
| `duration` | time from onset to −60 dBFS | within ± 25% of the declared length |
| `nodes` | nodes created | ≤ declared |

**`tools/audio-bench.mjs`** — a Node driver. Because Node has no
`OfflineAudioContext`, it runs the render inside headless Chromium via Playwright
and transfers the buffer back.

```
node tools/audio-bench.mjs                       # full offline gate, exit 1 on any failure
node tools/audio-bench.mjs --verbose             # per-case table
node tools/audio-bench.mjs --dump=melee.hit.bone # write a 48 kHz 16-bit WAV to ./audio-out/
node tools/audio-bench.mjs --dump=all            # all 263 ids, ~44 s
node tools/audio-bench.mjs --sheet               # one PNG: waveform + log spectrogram per id
node tools/audio-bench.mjs --scene=dense-combat  # scripted 60 s scene, LUFS + dBTP report
```

`--dump` is how a human auditions a sound: render, open the WAV, iterate on the
numbers in this document, re-render. No game, no browser window, no gesture.
`--sheet` puts the audio catalogue under the same pixel-diff gate the renderer
uses — a regression in a synthesis recipe becomes a visible image diff.

### The steps

| # | step | contents | acceptance gate |
|---|---|---|---|
| **1** | Skeleton and the no-op contract | `AudioSystem` class, gesture arming, `start()`, `dispose()`, the full public API returning `false`. No synthesis. | `npm run build` passes. `node tools/capture.mjs` produces a frame byte-identical to before the change (proves audio never starts under capture). Every public method called before `start()` returns `false` and throws nothing. |
| **2** | DSP toolkit and offline harness | `dsp.js` (envelopes, node helpers, saturation curves, `struckResonator`), `NoiseBank`, `selftest.js` with two trivial cases, `tools/audio-bench.mjs`. | `node tools/audio-bench.mjs` reports 2/2 pass. Noise bank build measures ≤ 35 ms. `--dump` writes a playable WAV. |
| **3** | Mixer | Six buses with §1.2 gains and compressors, master chain, `duck()` with the §7.2 rules, pause filter. | A full-scale burst into each bus leaves master peak < 0.99. A 1.0-amplitude sine into `sfx` with `duck('unique-drop')` applied measures **−5.0 ± 0.4 dB** at 300 ms and returns to 0 dB by 1 250 ms. A duck rule targeting `ui` is rejected by an assertion. |
| **4** | Reverb | `ir.js`, the six zone specs, lazy build, crossfade, disconnect-on-silent. | All six IRs render; measured RT60 (fit to the RMS envelope in 50 ms windows) within **± 12%** of spec; per-IR build ≤ 7 ms. A click through `altar` shows ≥ 2.4 s above −60 dBFS. Never more than two convolvers connected. |
| **5** | Spatial field | 48-emitter pool, equal-power panners, the §2.3 attenuation curve, distance darkening, room tint, propagation delay, stealing. | A click at 3 / 10 / 25 / 40 m measures **0.0 / −7.2 / −14.0 / −17.8 dB ± 0.5 dB**. Requesting 60 voices at once yields 48 built + 12 refused, zero errors. Every emitter returns to the free pool within 100 ms of its declared end. |
| **6** | Melee family (§5.1 A) | 20 ids, 8 full recipes. | 20/20 offline cases pass the gate. Spectral centroids separate the surfaces: **flesh < 900 Hz, stone 1 100–2 000 Hz, bone 1 600–3 000 Hz, metal > 3 000 Hz**. `--dump=all` auditions correctly. |
| **7** | Anti-machine-gun | Coalescing table, round-robin tables, mass-death promotion, per-frame acquisition budget. | Firing 12 × `melee.hit.bone` inside 40 ms builds exactly **3** voices. 12 × `actor:death` inside 150 ms builds **2 individual + 1 `death.mass`**. That render's peak < 0.95 and its RMS is within 3 dB of a single death. No two consecutive plays of any id use the same round-robin slot. |
| **8** | Spells (§5.1 B–F) | 59 ids, 8 full recipes. | 59/59 pass. `lightning.arc` L1 measures a 10–90% rise time **≤ 1.2 ms**. `meteor.telegraph` measures **1.20 s ± 30 ms**. `resonance.discharge`'s fundamental measures **73.42 ± 0.5 Hz** across 20 renders (the low-randomisation requirement). |
| **9** | Monsters and boss (§5.1 G–I) | 60 ids, 5 full recipes. | 60/60 pass. Each of the six types occupies a distinct spectral-centroid band, asserted against a table in `selftest.js`. `boss.p2.transition`'s fundamental measures **62 ± 2 Hz** and its total length **3.4 s ± 0.2 s**. |
| **10** | Player, items, UI (§5.1 J–L) | 63 ids, 4 full recipes. | 63/63 pass. The rarity ladder is **monotonic in both peak level and tail length** (normal < superior < magic < rare < unique). `drop.unique`'s 146.83 Hz hum partial is still ≥ −45 dBFS after the 60 m attenuation. The 12 footsteps are mutually distinguishable by centroid. |
| **11** | World objects and ambience (§5.1 M–N) | 34 ids, four zone beds, the zone crossfade. | A 60 s offline render of each bed shows no autocorrelation peak above **0.35** at any lag > 1 s (proves it does not loop). Bed CPU ≤ 4% of one core. A zone crossfade never produces a gain step > **0.5 dB per 20 ms**. |
| **12** | Music (§6) | Five layers, the intensity model, the lookahead scheduler. | Node count ≤ **40**. A 120 s render sweeping I = 0 → 1 → 0 tracks the §6.2 gain table within **1 dB**. A dev-only assertion in the scheduler fires if any note is outside the active mode's pitch set; 0 fires over a 10-minute run. The scheduler allocates 0 bytes per frame. |
| **13** | Mix pass | All duck rules wired to real events; the §7.1 level table applied. | `--scene=dense-combat` (12 monsters, one unique drop, one level-up, one Meteor, 60 s) reports integrated loudness **−23 ± 1.5 LUFS** and true peak **≤ −1.0 dBTP**. Every category's measured peak is within 2 dB of its §7.1 target. |
| **14** | Performance and degradation | The load estimator, the degradation ladder, quality presets, the node counter. | A synthetic storm (120 events/s for 20 s) keeps `renderCapacity` < **0.90** and produces zero dropouts. The ladder engages at exactly the §8.5 thresholds (logged and asserted). Live node count never exceeds **1 200**. `tools/profile.mjs` attributes ≤ **0.8 ms/frame** to `audio`. Zero buffers or IRs are generated while a zone is active. |
| **15** | Live probe | `tools/audio-probe.mjs`: boot headless with `--autoplay-policy=no-user-gesture-required`, press a key, `start()`, run `debugStorm()` (one of every one of the 263 ids through the real event bus), pump 300 frames, storm again, pump 300 more. | `AUDIO PROBE: PASS`. `report().errors === 0`. No `[error]` or `[pageerror]` console line. Five consecutive runs pass 5/5. Added to the M9 CI gate alongside `capture` and `imagediff`. |

---

## Appendix — catalogue summary

| family | ids | full recipes |
|---|---|---|
| A. Melee and physical combat | 20 | 8 |
| B. Fire spells | 12 | 3 |
| C. Ash spells | 9 | 2 |
| D. Lightning and Runeblade | 14 | 2 |
| E. Cold, poison and statuses | 16 | 1 |
| F. Ravager skills | 10 | — |
| G. Monsters | 51 | 4 |
| H. Champions, uniques, affixes | 14 | — |
| I. Molgrim | 15 | 1 |
| J. Player | 24 | 3 |
| K. Items and economy | 25 | 1 |
| L. UI | 14 | 1 |
| M. World objects | 11 | — |
| N. Ambience | 23 | — |
| O. Music | 5 | — |
| **total** | **263** | **26** |

Several recipes cover two catalogue ids (`meteor.telegraph`/`meteor.impact`,
`ashstep.out`/`ashstep.in`, `ice.impact`/`frozen.shatter`,
`maulsmith.windup`/`maulsmith.slam`), which is why the recipe column sums to 26 rather
than 30.
