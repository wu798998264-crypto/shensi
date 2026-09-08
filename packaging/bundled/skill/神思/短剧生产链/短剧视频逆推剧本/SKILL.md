---
name: short-drama-script-reconstructor
description: >
  Reverse-engineer short-drama episodes from public video links or uploaded video files into
  structured reconstructed scripts. Use when the user provides a short-drama video, episode URL,
  playlist/series page, or asks to reconstruct dialogue, characters, scenes, actions, sound effects,
  story continuity, or shooting-script style content from finished video.
---

# Short Drama Script Reconstructor

## Purpose

Convert a finished short-drama video into a **reconstructed production script** based only on
observable evidence in the finished video plus clearly labeled inference.

The goal is **not** to claim recovery of the writer's original source screenplay. Finished video
does not preserve deleted scenes, unshot descriptions, original wording, internal monologue, or
earlier script revisions.

Always describe the result as one of:

- reconstructed script
- reverse-engineered script
- shooting-script reconstruction
- reconstructed scene script

Never claim it is the exact original screenplay unless the user supplied the original screenplay
and asks for comparison.

---

# Supported Inputs

Prefer inputs in this order:

1. Public episode URL
2. Public playlist / series page
3. Direct-access video URL
4. Uploaded MP4/MOV/WebM or other supported video file
5. Extracted audio + frames supplied by the user

## Link-first policy

When the user provides a URL, attempt the link directly before asking for a downloaded video.

Do not ask the user to download the video first unless link access fails.

For a URL:

1. Open the page.
2. Determine whether the actual episode content is accessible.
3. Determine whether the page exposes:
   - playable video,
   - direct media,
   - subtitles/captions,
   - transcript,
   - episode list,
   - metadata.
4. If video content is accessible, continue.
5. If only a series page is provided, enumerate episodes and process them in order.
6. If the runtime can access a direct media stream/file, use it for frame/audio analysis.
7. If only captions are accessible, use captions for dialogue but clearly state that visual/action
   reconstruction may be incomplete.
8. If access is blocked, report the exact blocker.

## Never bypass access controls

Do not attempt to defeat:

- DRM
- paywalls
- account authentication
- CAPTCHAs
- region restrictions
- anti-bot systems
- encrypted protected streams
- private/unshared links

Do not fabricate analysis of inaccessible video.

Fallback order:

public page -> direct accessible media -> user-provided direct link -> uploaded video file.

---

# Core Operating Principle

Treat the task as **evidence extraction + story-state reconstruction + script formatting**.

Do not summarize the whole video in one pass and then invent a script.

Process the material hierarchically:

Video
→ Episode
→ Scene
→ Shot/beat
→ Observable events
→ Character attribution
→ Dialogue attribution
→ Audio events
→ Story-state update
→ Reconstructed script
→ Consistency pass

---

# Output Modes

Infer the most useful mode from the user's request. If unspecified, use **Mode B**.

## Mode A — Dialogue Script

Output:

- speaker
- dialogue
- optional timestamp
- off-screen / voice-over status when relevant

## Mode B — Standard Short-Drama Script (default)

Output:

- episode number/title if known
- scene number
- INT./EXT. or interior/exterior
- location
- time of day when inferable
- characters present
- action
- dialogue
- sound effects
- BGM/audio cues when narratively important

## Mode C — Director / Shooting Reconstruction

Add:

- shot number
- approximate timestamp
- framing / shot size
- camera movement when clearly observable
- character blocking
- key props
- transitions
- sound cues
- approximate shot duration

Never infer precise lens focal length, camera model, aperture, or technical settings unless visibly
or explicitly documented.

---

# Required Internal Data Model

Maintain these structures across the entire episode and, when multiple episodes are supplied,
across the entire series.

## 1. Character Registry

For every recurring person assign a stable internal ID.

Example:

CHAR_001
- canonical_name: unknown initially
- aliases: []
- visual_identity:
  - apparent gender presentation
  - approximate age band
  - hair
  - clothing
  - distinctive features
- voice_identity:
  - voice characteristics if useful
- first_seen
- last_seen
- role
- relationships
- evidence[]
- confidence

Rules:

- Never create a new character solely because clothes changed.
- Never merge two characters solely because they look similar.
- Use face, hair, body, voice, context, dialogue address, clothing continuity, and story logic
  together.
- If a later scene reveals a character's name, update the canonical name.
- When producing the final cleaned script, retroactively replace earlier temporary labels when
  confidence is high.
- Preserve uncertainty when identity is unresolved.

Temporary names should be neutral:
- Woman A
- Man B
- Receptionist
- Doctor
- Child
- Unknown caller

Avoid invented proper names.

## 2. Relationship Graph

Maintain relationships such as:

- parent / child
- spouse
- ex-partner
- fiancé/fiancée
- boss / employee
- sibling
- friend
- rival
- creditor / debtor
- doctor / patient

Each relationship must contain:

- source character
- target character
- relationship
- confidence
- supporting evidence
- first established timestamp/episode

Update relationships only when evidence supports it.

## 3. Location Registry

Track recurring locations:

LOC_001
- canonical_name
- temporary_description
- visual_features
- associated_characters
- episodes_seen
- evidence
- confidence

Example progression:

"large office"
→ "CEO's office"
→ "Gu Chen's office"

Only upgrade the label when dialogue, signage, continuity, or strong context supports it.

## 4. Prop Registry

Track narratively important recurring objects:

- contract
- necklace
- phone
- test report
- photograph
- ring
- bank card
- medicine
- weapon
- suitcase

Store owner, current holder, scene history, and story relevance when useful.

## 5. Story State

After each scene update:

- current known identities
- current relationships
- active conflicts
- secrets revealed
- unresolved questions
- location knowledge
- prop state
- injuries/status when narratively relevant
- timeline facts

This is the main cross-scene and cross-episode memory.

---

# Evidence Classes

Every extracted fact belongs to one of three classes.

## OBSERVED

Directly visible or audible.

Examples:

- character opens a door
- subtitle reads "Lin Wan"
- a phone rings
- character says "I'm your sister"

## INFERRED

Strongly supported by context but not directly stated.

Examples:

- room is probably the CEO's office
- two shots occur in the same location
- an off-screen voice probably belongs to Character A

## SCRIPTED_FILL

Minimal wording added only to make the reconstructed screenplay readable.

Examples:

- "She looks at him."
- "A brief silence."
- "He steps closer."

SCRIPTED_FILL must never introduce new plot facts.

When uncertainty matters, preserve it in notes rather than silently converting inference into fact.

---

# Confidence Scale

Use:

- 0.95–1.00: explicit / directly confirmed
- 0.80–0.94: strong evidence
- 0.60–0.79: likely
- 0.40–0.59: uncertain
- below 0.40: do not promote to canonical fact

High-impact uncertain facts include:

- character identity
- speaker attribution
- family relationship
- location identity
- chronology
- who performed an off-screen action

Flag these when confidence is below 0.80.

---

# Episode Processing Workflow

## Stage 1 — Acquire

For each episode:

- record episode URL/file
- episode number/title if available
- duration if available
- subtitle/transcript availability
- video accessibility
- audio accessibility

If a series page contains many episodes, create an episode queue and process sequentially.

Do not claim an episode was watched unless its actual audiovisual content was accessible.

## Stage 2 — Segment

Split into scenes using combinations of:

- hard cuts
- fades
- location changes
- time jumps
- major character-group changes
- soundtrack transitions
- title cards
- narrative discontinuities

Within each scene, split into shots or dramatic beats as needed.

Use approximate timestamps.

## Stage 3 — Visual Analysis

For each segment detect:

- visible characters
- entrances/exits
- posture and movement
- gestures
- facial expressions only when reasonably clear
- interactions
- key props
- readable signs/screens/text
- location/environment
- time-of-day indicators
- wardrobe continuity
- shot type for Mode C

Avoid overinterpreting subtle emotion.
Prefer "looks down and pauses" over "feels profound guilt" unless dialogue/context establishes it.

## Stage 4 — Dialogue & Speaker Attribution

Extract dialogue from available audio/subtitles/transcript.

Normalize obvious transcription errors using context, but preserve uncertain wording.

For each utterance determine speaker from:

1. visible lip movement
2. shot/reaction structure
3. voice continuity
4. subtitles with speaker labels
5. direct address
6. conversation turn structure
7. character position
8. story context

Label special speech:

- O.S. = off-screen
- V.O. = voice-over / narration
- PHONE = phone voice if relevant
- GROUP = multiple speakers

If speaker identity is uncertain, use the stable character ID or neutral label rather than inventing
a name.

## Stage 5 — Audio Event Analysis

Record narratively relevant sound:

- door
- knock
- footsteps
- phone ring/vibration
- message notification
- vehicle
- rain
- glass break
- slap/hit
- gunshot
- explosion
- crowd
- heartbeat
- transition sting
- BGM shift

Do not clutter the script with every ambient sound.
Keep sounds that affect story, pacing, or action.

## Stage 6 — Scene Fact Sheet

Before writing prose, build a fact sheet:

Scene ID
- start/end timestamp
- location
- time
- characters
- new character evidence
- dialogue
- actions in order
- props
- SFX/BGM
- new story facts
- uncertainties

Only after this fact sheet is internally coherent should the scene be rendered as screenplay text.

## Stage 7 — Update Story Memory

After each scene:

- resolve newly revealed names
- update relationships
- merge aliases
- update locations
- update recurring props
- record reveals
- record unresolved uncertainties

Do not rewrite previous evidence; update interpretation while preserving the original evidence.

## Stage 8 — Reconstruct Scene

Render the scene chronologically.

Default format:

EPISODE X

SCENE X
INT./EXT. LOCATION — TIME

Action.

CHARACTER
Dialogue.

[SFX: ...]

[BGM: ...]

Use concise production-style action lines.

Do not add internal thoughts unless they are conveyed through narration, dialogue, text-on-screen, or
clearly required by the user's requested adaptation style.

## Stage 9 — Consistency Check

Before finalizing an episode check:

### Character consistency
- same character keeps one canonical name
- temporary aliases correctly merged
- lookalikes not incorrectly merged
- clothing changes do not create duplicate characters

### Dialogue consistency
- speaker attribution fits shot/audio context
- dialogue order matches video
- narration and off-screen speech are labeled

### Scene consistency
- location names are stable
- scene boundaries are sensible
- time progression is not contradicted

### Plot consistency
- relationships do not contradict earlier evidence
- prop ownership/state is coherent
- revealed information is not used before it becomes known unless final retroactive naming is being
  applied only for readability

### Hallucination control
Remove any:
- invented plot fact
- invented dialogue
- invented proper name
- unsupported relationship
- unsupported motivation
- unsupported technical camera claim

---

# Multi-Episode / Full-Series Workflow

When multiple episodes are provided:

1. Process episodes in narrative order.
2. Maintain one global Character Registry.
3. Maintain one global Relationship Graph.
4. Maintain one global Location Registry.
5. Maintain global Story State.
6. Keep episode-local scene numbering.
7. After later identity revelations, allow canonical names to be used in the polished script of
   earlier episodes, but do not insert later plot knowledge into earlier dialogue/action.
8. Detect repeated recap footage and avoid treating recaps as new events.
9. Detect previews/trailers/end cards and separate them from episode narrative.
10. Track cliffhangers across episode boundaries.

For very long series, maintain a compressed continuity ledger after every episode.

Example:

Episode 12 continuity ledger
- Lin Wan now knows Gu Chen is her childhood rescuer.
- Gu Chen does not know Lin Wan knows.
- Su Man possesses the original necklace.
- Contract remains unsigned.
- Scene ends at hospital entrance.

This ledger must be used when processing Episode 13.

---

# Reconstruction Style Rules

Prefer screenplay language that is:

- chronological
- concise
- concrete
- production-readable
- evidence-grounded

Good:

"Lin Wan freezes. She looks at the divorce agreement, then raises her eyes to Gu Chen."

Avoid:

"Lin Wan's shattered heart collapses under the unbearable cruelty of destiny."

Unless such literary adaptation is explicitly requested.

Dialogue should preserve the spoken meaning and wording as closely as available evidence permits.

Do not beautify dialogue by default.

---

# Handling Subtitles

Subtitles are useful evidence but are not automatically ground truth.

Check for:

- subtitle timing drift
- censorship/rewording
- shortened subtitles
- OCR/transcription errors
- speaker mismatch
- missing interjections
- auto-caption mistakes

If audio and subtitle conflict and audio is clear, prefer audio.
If audio is unclear but subtitles are clearly official, prefer subtitles.
If both are uncertain, mark the line uncertain.

---

# Handling On-Screen Text

Capture plot-relevant text such as:

- names
- chat messages
- contracts
- test results
- headlines
- dates
- addresses
- caller IDs
- title cards

Do not invent text that is too small or blurred to read.

---

# Handling Recaps, Intros, Ads, and Previews

Classify non-story material:

- previous-episode recap
- opening title
- sponsor/ad
- platform overlay
- next-episode preview
- credits

Exclude these from the reconstructed episode script unless the user explicitly asks to preserve
them.

If a recap contains footage not present in the available prior episode, note it separately rather
than automatically inserting it into continuity.

---

# Default User-Facing Deliverable

For each episode provide:

1. Episode metadata
2. Reconstructed script
3. Character updates
4. Key continuity facts
5. Uncertain / low-confidence items

For a full series additionally provide:

- cast/character table
- relationship summary
- recurring location list
- master plot timeline
- unresolved ambiguity list

Keep the main screenplay readable; put uncertainty notes after the episode rather than interrupting
every line unless the ambiguity materially affects interpretation.

---

# Optional Structured JSON

When the user requests machine-readable output, use this conceptual schema:

{
  "series": {
    "title": null,
    "source_url": null
  },
  "episode": {
    "number": null,
    "title": null,
    "source": null,
    "duration": null
  },
  "characters": [
    {
      "id": "CHAR_001",
      "name": null,
      "aliases": [],
      "role": null,
      "relationships": [],
      "confidence": 0.0,
      "evidence": []
    }
  ],
  "scenes": [
    {
      "id": "E01_S01",
      "start": "00:00:00",
      "end": "00:00:00",
      "interior_exterior": null,
      "location": null,
      "time_of_day": null,
      "characters": [],
      "actions": [],
      "dialogue": [
        {
          "speaker": "CHAR_001",
          "text": "",
          "type": "ON_SCREEN",
          "confidence": 0.0
        }
      ],
      "sound": [],
      "props": [],
      "story_updates": [],
      "uncertainties": []
    }
  ]
}

---

# Completion Standard

An episode is complete only when:

- all accessible narrative footage has been covered
- scene boundaries are accounted for
- major dialogue is attributed
- primary characters are tracked consistently
- plot-relevant actions are present
- key sound cues are captured
- uncertainties are disclosed
- continuity check has been run

A series is complete only when every accessible episode has been processed and the global continuity
pass has been completed.

---

# Failure / Partial Access Behavior

If the video cannot be accessed:

State:

- what was accessible
- what was not accessible
- why the audiovisual reconstruction cannot be completed
- the minimal alternative input needed

Examples:

- "The episode page is public, but the video stream is DRM-protected."
- "I can read the captions but cannot access frames, so dialogue reconstruction is possible but
  action/scene reconstruction is incomplete."
- "The link requires account login."
- "The page loads, but the episode media is not exposed to this runtime."

Never replace missing audiovisual evidence with a plot summary found elsewhere on the web unless the
user explicitly requests a secondary-source reconstruction. If secondary sources are used, label
that output as source-assisted rather than video-derived.

---

# Execution Trigger

When the user gives a short-drama link after this skill is active:

1. Do not re-explain the whole workflow.
2. Immediately inspect the link.
3. Determine episode scope.
4. Start with Episode 1 or the specifically linked episode.
5. Produce the reconstruction using the default Standard Short-Drama Script mode unless the user
   requested another mode.
6. Carry story memory forward automatically for subsequent episodes.
7. If access fails, report the blocker and the best fallback; do not hallucinate the episode.
