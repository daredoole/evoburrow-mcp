# REW measurement and interpretation practices

## Measurement provenance

Source: REW Help and REW API beta documentation. Evidence: software author. Confidence: high.

Keep raw measurements and record microphone/calibration file, orientation, sample rate, sweep level, timing reference, processing state, and position. The REW API is REST-like with webhooks; its live OpenAPI document is served by REW on localhost port 4735 when the API server is enabled.

## Frequency response

Source: REW Help. Evidence: software author. Confidence: high.

Use suitable smoothing for broad tonal interpretation, but inspect finer resolution for narrow modal or cancellation behavior. Avoid boosting deep spatial nulls until placement and multi-seat behavior are understood.

## Time and decay

Source: REW Help. Evidence: software author. Confidence: high.

Impulse, phase, group delay, decay, waterfall, spectrogram, and RT-style views answer different questions. A single frequency-response trace cannot establish timing alignment or decay performance.

## Validation

Source: engineering practice. Evidence: heuristic. Confidence: high.

Use repeat measurements and before/after comparisons with identical acquisition settings. Separate measured changes from listening preference, and level-match subjective comparisons.
