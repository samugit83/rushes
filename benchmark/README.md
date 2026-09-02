# The first-pass-usable benchmark

One narrow question, and only one: **can an ordinary coding agent produce a
usable video on attempt 1, without a human repairing it?**

That number is what tells you whether a catalogue of forty videos is a weekend
or a year. It is the same instinct as owning a measurable outcome metric rather
than counting stars: a benchmark you can fail is worth more than a claim you
cannot.

## The three gates, all required

1. `rushes validate <id> --quality showcase` exits zero.
2. `rushes deliver <id> --quality showcase` exits zero, with zero check errors.
3. A **named human reviewer** watched it and recorded `passed` with no defects.

A renderer-valid but semantically wrong output is a FAILURE. A video where every
step resolved and every check passed, but scene 4 narrates something the viewer
never saw, did not pass gate 3, and gate 3 is not optional.

## The protocol

1. Take ten entries from the catalogue.
2. Write a case file per entry: the required scenes, and the semantic keys their
   narration must cover.
3. Hand an agent the brief plus `SKILL.md`. Nothing else.
4. **Freeze whatever `demos/<id>.demo.json` it produces.** No post-hoc edits, no
   "just one fix". The moment you repair the storyboard, you are measuring
   yourself instead of the agent.
5. Score.

```bash
node benchmark/run.mjs                 # every case
node benchmark/run.mjs --case tour     # one
```

`firstPassUsable` is the percentage that passed all three gates. Record the
model, the date and the commit alongside it: the number means nothing without
them, and a number quoted without them is the thing this benchmark exists to
avoid.
