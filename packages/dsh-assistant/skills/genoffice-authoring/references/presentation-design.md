# Presentation design adapted from GenOffice

Based on the locked upstream `skills/genoffice/SKILL.md` v2.67.1 and `packages/pipelines/src/slides/guides/design.md`. This environment uses native Office tools; the standalone CLI commands in the original reference are not installed workflow steps.

Plan the deck before placing elements. Decide the audience, one central claim, evidence and the action/conclusion the final slide should support. Use the user's actual facts; mark illustrative figures. Reuse an existing deck's design when editing it.

Keep a compact style sheet for the deck: main/background/text colors, at most two accents, available Latin and CJK fonts, title/body size ranges and a small library of page layouts. Keep these decisions in view for each page rather than inventing new styling independently. Honor a supplied brand or theme.

Write a page-by-page outline with title, purpose, layout and the facts that belong in each region. Turn each entry into its own page spec in a focused step, then assemble the ordered `pages` array for `file_office_create`. Use variations such as typography cover, three-column cards, comparison, timeline, KPI row, chart with insight and conclusion; consecutive dense pages need deliberate hierarchy. Keep the canvas units from the PowerPoint contract consistent; operations use their own OOXML units.

Use actual supplied images or embedded generated assets when available. Choose a typography/shape layout if suitable media is unavailable; do not label a grey rectangle as a completed photo. The worker accepts only inline supported media and does not search or download it.

Keep each page's hierarchy legible: a concise claim/title, grouped supporting content, enough whitespace, and a consistent alignment grid. Tables should be readable at presentation size. Native charts should carry the relevant series, labels and insight, rather than a decorative screenshot.

After generation, read the slide count, semantic objects and `layoutAudit`. Resolve overflow, out-of-bounds and unintended overlaps; a saved PPTX alone is insufficient evidence of good composition. Decorative background/title overlays can be intentional, but require judgment. Where the available viewer can render the saved result, inspect the pages, especially dense CJK text and charts. Use existing-file operations for focused changes and inspect the resulting new version. Prefer at most two correction rounds; report any remaining concrete limitation instead of silently looping or claiming visual verification without viewing the output.
