# A1 Evo AcoustiX developer walkthrough

Source type: software-author/developer statement.  
Source: OCA video supplied as a full transcript by the user; video linked from the A1 Evo AcoustiX AVSForum first post: https://www.youtube.com/watch?v=QvL7ZhcV0dc  
Applicability: the AcoustiX release demonstrated in the video. Confirm behavior against the installed release and generated artifacts.  
Confidence: high for what the developer says the demonstrated build does; medium or low for analogies, generalized engineering claims, and subjective outcomes.

## Evidence rules for this transcript

- Treat menu names, file lifecycle, limits, and demonstrated workflows as developer-reported product behavior.
- Treat exact version requirements as release-specific. The video says REW beta 109 or newer, while the current local executable requests a later beta; obey the installed executable.
- Treat MIMO descriptions as implementation explanation, not proof that AcoustiX duplicates Dirac ART.
- Treat listening impressions, suggested repeat counts, crossover preferences, and claims about other products as opinions or heuristics requiring measurement.
- Do not promote the transcript’s expansion of “chirp” as an established acronym; preserve it only as narration.

## Distribution and prerequisites

The application is portable rather than conventionally installed. The developer describes builds for Windows, Intel and Apple-silicon macOS, and Linux, accompanied by `target_curves` and tactile-response/bass-shaker curve folders. Windows users may need to unblock the downloaded executable and benefit from Windows Terminal for correct symbols.

AcoustiX requires an API-capable REW beta and can launch REW itself. The exact minimum changes by AcoustiX release, so version checks from the running binary take precedence over the video.

## Receiver configuration invariants

Before measurement, confirm Amp Assign, actual speaker presence/layout, height-channel naming, subwoofer count, and bass-shaker mapping on the receiver itself. The developer advises using the physical receiver UI rather than its web UI for these structural settings because he observed model-specific web-UI persistence bugs.

The transcript recommends leaving speakers set to Small during this workflow because some receiver models reportedly fail when the transfer changes Large back to Small. This is a developer-reported compatibility precaution, not a universal Denon specification.

On older two-sub-output models, a tactile transducer is represented as the second subwoofer. On newer four-output models, the developer expects the tactile transducer at SW4 and acoustic subwoofers at SW1-SW3. Hardware changes require replacing/redetecting the AVR configuration before further work.

## Physical setup

Place and toe speakers before measurement, verify wiring and polarity, and treat AcoustiX polarity warnings as prompts for inspection rather than infallible diagnoses. The developer reports seeing frequent polarity errors in user measurements, including polarity changes introduced by external amplification.

Disable subwoofer DSP, room EQ, low-pass processing, and convenience modes when practical; use LFE/direct input, maximum LPF, and Always On during measurement. Auto-on can miss early chirps. Quiet the room, stop fans/HVAC, close openings, and place the AVR microphone at seated ear height pointing upward.

## Measurement workflow

Run a one-repeat test first to expose silent channels, disconnected amplification, microphone problems, or receiver/network failures before committing to many repeats. The developer suggests roughly 3 repeats as a minimum and 6-9 for stronger repeatability, while explicitly presenting this as workflow advice rather than a guarantee.

For multi-position capture, the first position is the main listening position and determines distances. The demonstrated release supports up to 20 positions and up to 9 repeats per position. The developer suggests positions roughly 50 cm around MLP as a starting point, while allowing wider coverage such as one position per seat. Preserve exact position metadata because averaging cannot recover undocumented geometry.

AcoustiX selects/averages repeats using signal-to-noise logic and reports the chosen reference/method. Off-center and polarity warnings should be investigated. Repeating the complete measurement can improve results when receiver output or environmental conditions vary, but claims about mains-power-specific wobble remain unresolved observations.

## Artifacts and state-aware menu

The menu adapts to files in the working folder:

- Receiver configuration enables receiver-aware workflows.
- `.ady` measurement files enable optimization.
- `.oca` calibration files enable transfer.
- HTML reports preserve optimization details.
- Timestamped REW measurement/result files preserve intermediate and final states.

Express runs measurement, default optimization, and transfer. Advanced flows separate sub-level work, measurement, default/custom optimization, transfer, and AVR configuration replacement.

## Distances, timing, and level alignment

Calibration distances are relative timing controls, not geometric measurements. A larger AVR distance causes earlier playback. Subwoofer values can be much longer than physical distance because of acoustic and electronic delay. Receiver distance resolution limits the precision achievable; the transcript describes steps around 3-3.4 cm on relevant models.

The developer states AcoustiX performs finer-than-0.5 dB volume alignment partly through filters and uses ISO 226-derived logic. Treat this as an implementation claim until independently verified from outputs and measurements.

## Target and tactile-response curves

Target curves should reach about 3 Hz and 24 kHz and equal 0 dB at 1 kHz. Avoid unintended end slopes. Tactile-response curves extend lower, may retain content around 2 Hz, and generally should not contain meaningful output above roughly 50 Hz. Validate generated files before use.

Flat is described as the normal optimized result. Reference may carry low-volume compensation with more bass and treble. In custom-filter mode, Flat remains the optimized baseline and Reference becomes the custom-filter result for quick comparison, replacing the usual low-volume comparison.

## Crossover customization

AcoustiX searches crossover ranges during optimization. Constraining a channel group to a fixed value changes the filters generated for that crossover and is therefore not equivalent to changing only the AVR crossover afterward. Use measured speaker capability, distortion/headroom, and crossover-region summation when choosing ranges.

The developer emphasizes that inferred subwoofer roll-off limits are used for level decisions and do not necessarily mean AcoustiX adds duplicate high-pass or low-pass filters at those exact frequencies.

## Interactive leveling and reversible experimentation

Interactive volume alignment allows target and subwoofer levels to be moved in REW before confirmation. Cancel is intended to restore the pre-interaction state. Record offsets and preserve the default result so subjective changes remain reversible and comparable.

Psychoacoustic smoothing can make narrow dips appear as a broader perceived level reduction. The developer warns that aggressively filling a visible null can add distortion and ringing; test a modest overall target change before narrow high-gain correction.

## Bass management and MIMO mode

The developer describes bass extraction as full-range fronts plus subwoofer contribution up to a selected frequency (double bass/LFE+Main). LPF for LFE is normally 120 Hz in his workflow, though it remains a receiver setting rather than an intrinsic calibration constant.

In the demonstrated MIMO mode:

- LFE+Main/double bass is mandatory.
- Fronts and subwoofer form a joint front-soundstage result rather than independently flat responses.
- The initial implementation is presented primarily for XT32 because of filter bandwidth and independent-sub limitations.
- MIMO upper limits include 200/250 Hz; lower selections can require separate front EQ above the MIMO band.
- Front/sub customization is restricted while MIMO owns those filters.
- Useful evaluation measures the combined listening result; individual responses may look poor by design.

The radar/virtual-array analogy and comparisons with Dirac ART explain intent, not demonstrated equivalence. The developer’s own listening report is mixed and system-dependent: different/enveloping bass, but not necessarily preferred over conventional alignment in his room.

## Subwoofer alignment choices

The default workflow prioritizes fronts for subwoofer time alignment. Adding center, surround, or height groups trades among seats/channels because a single subwoofer delay cannot perfectly align every speaker at different distances. Claims that including the center necessarily degrades imaging are configuration-dependent and should be measured.

Large required subwoofer delays can exceed an AVR’s distance range. AcoustiX can only optimize within available hardware limits; moving the subwoofer or changing its DSP/port behavior may be more effective than further filtering.

## Manual time alignment

Manual time alignment is intended for difficult cases, especially Dolby-enabled upfiring speakers where the direct impulse can precede the stronger ceiling reflection. Align the intended reflected arrival, set ceiling height before measurement, and avoid obsessing over residual errors smaller than receiver delay resolution.

Do not apply this reasoning blindly to subwoofers. Crossover-band phase and group-delay behavior require band-limited analysis rather than only matching full-band impulse peaks.

## Custom REW filters

Custom mode can import REW EQ filters, target changes, windowing, and supported all-pass filters per channel. The transcript demonstrates this as an expert learning environment, not a recommendation to flatten every channel full range.

High-frequency boost at high playback levels can thermally stress tweeters. Deep-null boosts can consume headroom and increase distortion without fixing spatial cancellation. All-pass filters change phase without changing magnitude, but graphs alone do not prove audibility or correctness. Use reversible A/B comparisons and after-measurements.

The transcript discusses dialogue-enhancement boosts near 2.5 and 5 kHz as an experiment. These are not universal prescriptions and can increase harshness, reduce headroom, or conflict with the speaker’s directivity; they must not become automatic defaults.

## Multiple subwoofers and tactile transducers

AcoustiX aligns multiple subwoofers, then offers a combined level adjustment. The developer identifies a multi-sub interactive-leveling problem during the recording and says he intends to fix it before release; therefore, behavior must be verified in the installed build rather than assumed from the demonstration.

Tactile transducers are excluded from acoustic sweeps, receive their own curve, gain, polarity, and timing controls, and default to the acoustic subwoofer delay unless changed. The developer recommends treating the transducer as a sub output rather than relying on receiver-specific tactile modes when those disable needed flexibility.

## Practical hierarchy

The developer’s closing priority is sound: fix setup, wiring, placement, receiver configuration, and subwoofer position before seeking a “magic” curve. A small physical move—his example is roughly 30 cm—can outperform aggressive correction when geometry causes the problem.
