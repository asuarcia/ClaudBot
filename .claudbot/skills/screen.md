---
name: screen
description: How to see what the user is working on, when screen awareness is on
---

# Screen awareness

The user can let Claudbot watch their screen. When it's on, a heartbeat captures
the screen every few minutes, a NIM vision model describes it, and a short
rolling summary is kept.

## Reading it

```
node screen.mjs context
```

That prints everything you should ever load: the path of the **single latest
capture** and a rolling text summary of what has been on screen. Read the image
path only when you actually need to look — the text summary usually answers the
question.

Never try to enumerate past screenshots. There aren't any: older frames are
deleted, not archived, on purpose.

## When the user says "look at my screen"

```
node screen.mjs now
```

Captures and describes immediately, regardless of the heartbeat. Use this for
"what am I looking at", "read this error for me", "what's on my screen right
now".

If it reports that screen awareness is off, say so and offer
`claudbot screen on` — do not turn it on yourself. Capturing someone's screen is
theirs to opt into.

## Cost

Descriptions run on the `vision` agent (NIM). Do not describe screenshots
yourself when the heartbeat can do it — background polling must not spend Claude
plan usage. See `docs/cost-routing.md`.

## Controls

| | |
|---|---|
| `claudbot screen on` | start the heartbeat |
| `claudbot screen off` | stop it and delete every capture |
| `claudbot screen now` | capture right now |
| `claudbot screen status` | is it on, and what has it seen |
