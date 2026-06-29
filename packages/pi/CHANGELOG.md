# @tml/pi

## 5.0.0

### Patch Changes

- Updated dependencies [e9d8a4c]
- Updated dependencies [1cc55a9]
- Updated dependencies [bffb297]
  - @tml/core@0.5.0

## 4.0.1

### Patch Changes

- 0d29d94: Make review output readable instead of raw structured data. The agent's findings JSON no longer streams into the log: a schema run's text payload is suppressed at the harness (tool activity still streams), and the review pass logs a plain-English line of what it found and, on completion, a found-to-outcome overview (`N findings → M auto-fixed · K need your decision · J noted`). In the TUI, each finding leads with its title (severity badge and status glyph alongside, file:line and detail below) in both the findings tab and the approval drawer, the findings tab sorts by severity (worst first) and shows lifecycle status so you can tell what was fixed, and the PR-body review summary shows every finding with its lifecycle status so a reader can tell what was fixed and what still stands.

## 4.0.0

### Minor Changes

- b5b6f73: Expose harness discovery APIs: core now exports registered harness inspection and optional harness detection metadata, and the pi harness exposes configurable binary resolution for detection.

### Patch Changes

- Updated dependencies [b5b6f73]
  - @tml/core@0.4.0

## 3.0.0

### Patch Changes

- Updated dependencies [2c74ebe]
  - @tml/core@0.3.0

## 2.0.0

### Patch Changes

- 48c49a7: Reject already-aborted pi harness runs before spawning the pi process.
- Updated dependencies [a7ad94a]
- Updated dependencies [bbe9356]
- Updated dependencies [5b299f9]
- Updated dependencies [e18a90a]
- Updated dependencies [7a7f09b]
- Updated dependencies [060cf35]
- Updated dependencies [b82db55]
- Updated dependencies [30a20ba]
- Updated dependencies [49d5d49]
- Updated dependencies [6a2f301]
- Updated dependencies [82ea0a4]
- Updated dependencies [2958361]
- Updated dependencies [fdd146c]
- Updated dependencies [e603844]
- Updated dependencies [a9f93ca]
- Updated dependencies [4f593a7]
- Updated dependencies [1d7fb72]
- Updated dependencies [45fa664]
- Updated dependencies [e4a711f]
- Updated dependencies [a9f93ca]
- Updated dependencies [1ce2958]
- Updated dependencies [edad77f]
- Updated dependencies [6b227d1]
- Updated dependencies [c209d54]
- Updated dependencies [060cf35]
- Updated dependencies [577b729]
- Updated dependencies [c065c58]
- Updated dependencies [6b227d1]
- Updated dependencies [1c6baf3]
- Updated dependencies [728abc0]
- Updated dependencies [e3a1b4d]
- Updated dependencies [b8adcbb]
- Updated dependencies [060cf35]
- Updated dependencies [c332844]
- Updated dependencies [dcf7534]
- Updated dependencies [2f7c7a8]
  - @tml/core@0.2.0

## 1.0.0

### Patch Changes

- Updated dependencies [cafb140]
- Updated dependencies [d7ae10f]
  - @tml/core@0.1.0
