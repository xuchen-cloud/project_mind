# Generate Record Exports from one document model

Record Export first projects persisted Committed Content HTML into one format-independent export document model, then Markdown/ZIP, DOCX, and PDF generators consume only that model. This keeps application-specific nodes, links, images, annotations, and normalized rich-text semantics aligned across formats, instead of letting three generators independently interpret editor HTML or depend on a local Office installation.
