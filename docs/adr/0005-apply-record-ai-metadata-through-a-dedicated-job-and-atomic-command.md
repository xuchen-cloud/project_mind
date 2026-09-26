# Apply Record AI metadata through a dedicated job and atomic command

AI Metadata Fill uses its own `record_metadata` Job instead of representing a fixed product capability as an AI Editor Skill or AI Answer. The Job receives only Record Committed Content and Tag options from that Record's scope, and returns validated structured metadata.

Before applying the result, the page flushes the current Record's Committed Content. A dedicated metadata command then creates any new Tag options, updates the Record title, and replaces Tag links inside one database savepoint. This prevents failed requests from leaving a new title, partial Tag selection, or orphaned newly-created Tags.

## QuickNote publication

Publishing a whole QuickNote as a new Record is an explicit user action that starts AI Metadata Fill after the Record transaction succeeds. Autosave writes only the QuickNote, and appending to an existing Record does not regenerate its title. Explicit body hashtags are promoted to Record Tags before AI suggestions are merged. The AI title prefers a title-like first line only when it describes the full content.

The initial Record remains usable when AI is unavailable or fails. Metadata apply compares the saved Record revision/title before writing; opening or editing that Record cancels a pending automatic apply. Metadata failure never rolls back the published body or restores the cleared QuickNote.

Writing a Record and clearing its matching QuickNote happen in one database savepoint. The editor serializes autosave and publication, temporarily locks editing during publication, and ignores queued saves from the prior draft generation. A failed transaction retains the QuickNote for retry.
