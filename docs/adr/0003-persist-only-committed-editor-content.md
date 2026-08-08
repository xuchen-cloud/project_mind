# Persist only committed editor content

Editor persistence reads a Committed Content projection instead of the live preview document. Normal edits remain saveable while every unaccepted AI region projects to its original content, so streaming previews cannot leak through close, failure, retry, unmount, Workspace switching, or parent-driven saves.
