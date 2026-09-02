---
name: Slide block request
about: A composed slide needs an arrangement the vocabulary does not have
labels: slides
---

**What the slide has to show**

Describe the topology, not the styling. How many things, and how are they
related?

**Why an existing block does not fit**

`flow-row` `sequence` `ring` `compare` `stack` `hub` `store` `badge-list`
`metric` `code` `quote` `bullets` `title`.

**What its capacity should be**

Every block declares a maximum, because capacity is what stands in for a layout
solver. Above it, the answer is to split the slide.

**Have you tried authored mode?**

If the slide has no topology, `mode: "authored"` already exists and is first
class. This template is for slides that genuinely have one.
