# Preserve voice source tracks before live mixing

A Voice Record preserves synchronized microphone and system audio as separate source tracks while a derived mixed stream is used for real-time recognition. Both sources must be available before a Recording Session can start; the product does not silently degrade to a single source. This costs more storage and audio-pipeline complexity, but retains the information needed for echo control, source-specific processing, and later retranscription; saving only the mixed stream would discard that information irreversibly.
