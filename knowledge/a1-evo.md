# Curated A1 Evo AcoustiX knowledge

## Prerequisites

Source: A1 Evo executable and AVSForum first-post guide.

Use a current REW API beta, verify AVR Speaker Configuration and Amp Assign, check wiring/polarity/placement, disable subwoofer internal processing, maximize its LPF, quiet the room, and connect the supported calibration microphone. The local A1 executable exposes Express Calibration plus separate measurement, optimization, custom optimization, transfer, sub-level, and receiver-configuration flows.

## Multi-position and imported measurements

Source: AVSForum A1 Evo AcoustiX FAQ.

AcoustiX can use Acoustica and MultEQ application measurements, but only the main-listening-position measurement is used. Native AcoustiX capture is required for its multi-position workflow. Encrypted Evo One files are not compatible.

## MIMO

Source: AVSForum A1 Evo AcoustiX FAQ and community reports.

The project describes MIMO as reducing decay and improving bass clarity in a manner conceptually similar to Dirac ART. Reduced reverberation may be perceived as less bass, so a listener may prefer a heavier target curve afterward. Treat subjective reports and particular cutoff values as room-specific, not defaults.

## Target curves

Source: AVSForum A1 Evo AcoustiX FAQ and Target Curve Studio Pro thread.

Target curves belong in A1’s target_curves folder and should span approximately 3 Hz to 24 kHz with 0 dB at 1 kHz. Target Curve Studio Pro is a separate free offline Windows/macOS/Linux application for curve creation and editing; its forum thread reported version 5.5.0 on January 10, 2026.

## Post-transfer checks

Source: AVSForum page 28 community reports.

Compare the AVR state with the generated HTML report after transfer. A successful repeat transfer resolved missing settings for one user, but that is a case report, not a universal fix. Distances are timing parameters and should not be replaced by tape-measure values without acoustic evidence.

## Known local failures

Source: session logs in the parent A1 workspace.

Observed failures include calibration microphone not detected, EXIT_AUDMD timeout/no ACK, unreachable AVR control at port 1256, recovery failure, and port 3000 already in use. Diagnose the exact evidence before retrying.
