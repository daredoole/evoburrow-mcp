# Calibration interpretation

## Reliable invariants

- Preserve original `.ady`, `.oca`, `.avr`, REW `.mdat`, and HTML reports before experimenting.
- A1 Evo AcoustiX target curves should cover roughly 3 Hz through 24 kHz and be normalized to 0 dB at 1 kHz.
- Imported Acoustica or MultEQ measurements use only the main-listening-position measurement; native multi-position work requires AcoustiX measurement capture.
- Reported AVR distances—especially subwoofer distances—encode timing, not tape-measure geometry. Do not “correct” them from physical distance alone.
- Do not change crossovers, trims, or distances after transfer without a measured reason and a reversible comparison.

## Engineering checks

- Verify channel mapping and polarity before optimizing frequency response.
- Compare repeated positions for consistency; a large timing or level outlier is more likely a measurement/setup issue than a target-curve issue.
- Judge MIMO and bass changes with decay/impulse evidence plus level-matched listening. Reduced decay can sound leaner even when bass definition improves.
- Keep bass-management decisions compatible: speaker crossover, bass extraction, LPF for LFE, and subwoofer capability are related but not interchangeable.

## Sources

- AVSForum A1 Evo AcoustiX thread, first-post FAQ and page 28: https://www.avsforum.com/threads/a1-evo-acoustix-from-oca-the-latest-version-of-sound-optimization-suite-diracart-denon-marantz.3336786/page-28?nested_view=1#replies
- REW API beta thread by the REW author: https://www.avnirvana.com/threads/rew-api-beta-releases.12981/
