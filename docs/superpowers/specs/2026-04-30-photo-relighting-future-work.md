# Photo Relighting — Future Work

**Status:** Living document. Items here are explicitly **out of scope for the MVP** but tracked so they aren't forgotten. Each item is its own future spec when we get to it.

Companion doc: `2026-04-30-photo-relighting-mvp-design.md` (the MVP spec).

---

## Phase 3 — Cast shadows

The subject blocks light from reaching surfaces behind it.

- **Approach 1:** Ray-march through the depth heightfield. Per pixel, step toward each light position checking for occluders. Soft shadows via cone tracing or PCSS-style sampling.
- **Approach 2:** Project subject silhouette as a planar shadow onto the background's depth-implied surface.
- **Cost:** ~200–800 ms per render, sensitive to depth artifacts at edges.
- **Where it plugs in:** Inside `lighting/shaders.py` and `relight.frag`, after diffuse + cone + gobo, before composition. The hook already exists — adds a `cast_shadow_factor` term to the per-pixel loop.
- **MVP design accommodates this:** the renderer is structured so cast-shadow rendering is additive, not a refactor.

## Phase 4 — Diffusion polish (IC-Light)

Use IC-Light or a similar diffusion model as an optional finishing pass that takes the shader-rendered output and makes it more photographic.

- **Approach:** After classical render, optionally pipe through IC-Light conditioned on the lighting setup. Gives photorealistic textures, soft contact integration, and natural color spill that classical shading can't produce.
- **Cost:** ~10 GB extra weights, 5–15 s per render.
- **UI:** Toggle on the export panel — "Polish with diffusion (slow)". Preview always classical.
- **Why deferred:** Contradicts the MVP product framing of *control* over realism. Belongs as a final-step option once the controllable foundation works.

## ICC-aware color management

Real color science. Read input ICC profile → convert to a known working space (linear ACEScg or linear sRGB depending on input) → convert to output space and embed correct profile.

- **Why deferred:** Doing it half-right is worse than not doing it. Real ICC handling is its own focused project. MVP's "sRGB-assumed, profile noted" is acceptable for now.
- **When to do it:** When users start submitting wide-gamut TIFFs from professional pipelines and reporting color shifts.

## Custom gobo upload

`POST /gobos` endpoint, plus a small storage and management UI.

- **Server:** accept PNG/JPEG, validate dimensions, store under user namespace, return `gobo_id`. Default projection mode declared at upload time (spotlight rectangular vs. equirectangular).
- **Client:** "Upload gobo" button; manage user-uploaded gobos in the picker.
- **Why deferred:** Six built-in presets cover common cases. Upload is additive when needed.

## Fixture library

A user-facing **fixture preset** system. When adding a new light, the user picks a fixture type — e.g. "Cone (focused beam)", "Flat panel (LED)", "Standard bulb (tungsten)" — and the system fills in `Light` field defaults appropriate for that fixture (type, color/Kelvin, cone angle, falloff curve, default softness, etc.). Users can then tweak from the preset baseline.

**Initial proposed fixture catalog:**

| Fixture | `type` | Defaults | Visual character |
|---|---|---|---|
| Cone / Focused spot | spotlight | tight cone, low softness, ~3200 K | hard-edged narrow beam |
| Fresnel | spotlight | medium cone, medium softness, ~5500 K | classic cinema spot |
| Softbox / Flat panel | spotlight | wide cone, high softness, ~5500 K | even wash, soft edge |
| LED panel (bicolor) | spotlight | wide cone, medium softness, color picker exposed | studio LED |
| Standard bulb (tungsten) | point | quadratic falloff, ~2700 K | omnidirectional warm |
| Halogen bulb | point | quadratic falloff, ~3200 K | omnidirectional warmer |
| Fluorescent tube | spotlight | very wide cone, soft, ~4100 K + slight green | overhead/practical |
| Practical (in-scene lamp) | point | strong falloff, ~2400 K | visible light source |
| Sunlight | directional | aim from above-right, ~5500 K, no falloff | hard parallel rays |
| Skylight | directional | broad/soft equivalent, ~7500 K, no falloff | overcast feel |
| Strobe / Flash | spotlight | medium cone, low softness, ~5500 K, high intensity | high-impact key |
| Rim / Hair | spotlight | narrow cone behind subject, slightly cool, low intensity | edge separation |

**Data model implication:** The engine's `Light` dataclass is **already fixture-ready**. No engine changes needed for the basic version — fixtures are presets in a JSON file (`relighting_engine/assets/fixtures.json`) plus a UI picker. A later refinement could add a `fixture_id` field on `Light` for round-trip serialization that remembers the originating fixture.

**UI surface:**
- "+ Add light" button on the light list opens a fixture picker grid (icon + name).
- Picking a fixture creates a new `Light` populated from the fixture template.
- The picker is what lets the light-list grow beyond MVP's three slots — the fixture system and the unlimited-lights upgrade are natural to ship together.

**Why deferred:** UI complexity (picker, light-list management, per-fixture default tuning) is real, and the MVP's three named slots cover the core use case.

## SAM2 segmentation backend

Replace or augment RMBG with SAM2.

- **Why:** click-to-refine masks; better edge quality on hair, fur, complex silhouettes.
- **Engine impact:** drop-in via the existing `seg_backend` parameter. Both backends conform to the same adapter interface.
- **API impact:** an optional `mask_hint_points: [[x,y,label], ...]` parameter on `/prepare` (or a new `/refine_mask` endpoint).

## Confidence-aware lighting

DA3 returns a confidence map alongside depth. Currently unused.

- **Idea:** fade light contribution in low-confidence regions (typically silhouette edges and disocclusions) to suppress artifacts.
- **Implementation:** multiply `total - ambient * original` by `confidence` before clamping. One-line shader addition once we wire confidence through `PreparedImage`.

## Multi-user / multi-worker API

When deploying behind public traffic.

- Replace the in-process session dict with Redis (or similar) for cross-worker session sharing.
- Add bearer-token auth, per-token rate limits.
- GPU pool with a request queue. Likely Modal or RunPod for elastic capacity.

## Animation / video

Per-frame relighting with temporal consistency.

- Substantially different product. Requires temporal smoothing of depth and normals (current frame-by-frame would flicker).
- Likely a separate spec built on top of stable per-frame relighting.

## Mobile / CPU inference

ONNX Runtime + DirectML/CoreML/etc. for non-CUDA execution.

- DA3 ONNX export is plausible. RMBG ONNX exists today.
- Performance order-of-magnitude slower; UX would need adjustment (probably no real-time preview on CPU).

## Alpha-as-mask shortcut

When the input has an alpha channel, optionally use it as the subject mask, skipping segmentation.

- One-flag change on `/prepare`.
- Useful for users coming from Photoshop with already-cut subjects.

## Cast-shadow brush

Manual contact-shadow paint tool.

- A separate UI overlay where the user can paint a soft shadow blob beneath the subject.
- Useful before Phase 3's full cast-shadow rendering ships, and as a fallback when ray-marched shadows have artifacts.

## Light presets / scene save

Save and recall full lighting setups by name. Round-trip the entire `lights[]` array as a named preset on disk or per-user.

- Trivially additive to the API (`POST /presets`, `GET /presets/:id`).
- Useful once users start working across multiple images and want consistent lighting "looks".

---

## How to add to this list

When something is intentionally deferred, add a new section here with:

1. **What it is** — one-paragraph description.
2. **Why deferred** — what makes it the wrong thing for now.
3. **What to know when picking it up** — engine seams it touches, existing affordances that anticipate it, dependencies on other deferred items.

Ordering is not strict priority — items group by theme. Priority is decided when planning the next spec.
