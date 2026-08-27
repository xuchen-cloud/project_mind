# Apply Record AI metadata through a dedicated job and atomic command

AI Metadata Fill uses its own `record_metadata` Job instead of representing a fixed product capability as an AI Editor Skill or AI Answer. The Job receives only Record Committed Content and Tag options from that Record's scope, and returns validated structured metadata.

Before applying the result, the page flushes the current Record's Committed Content. A dedicated metadata command then creates any new Tag options, updates the Record title, and replaces Tag links inside one database savepoint. This prevents failed requests from leaving a new title, partial Tag selection, or orphaned newly-created Tags.
