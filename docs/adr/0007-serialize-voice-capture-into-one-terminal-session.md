# Serialize voice capture into one terminal session

The application permits only one unfinished Recording Session at a time. Pause retains that session, while explicit end is terminal; application exit must end and save it rather than leaving capture running in the background. This gives microphone and system-audio capture one unambiguous owner and keeps one coherent timeline and minutes boundary, at the cost of parallel recordings and background capture after quit.
