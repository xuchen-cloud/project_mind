# Print-only font derivatives

Pinned source: `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`, original `apps/docs/src/renderer/fonts/` CFF WOFF2 subsets. Original screen fonts and vendor sources remain unchanged.

macOS WKWebView PDF output emits empty ToUnicode for the source CID-keyed CFF body font. These OFL derivatives use TrueType quadratic outlines and new internal family names. The converter retains character-to-glyph IDs, all glyphs, horizontal/vertical advance metrics, layout tables and units-per-em; curve approximation is bounded at 0.0005 em. They are selected only when embedding native print/PDF HTML. No text is rasterized.

`source-lock.json` pins source and output SHA256/size, converter versions and glyph counts. Normal Node builds verify these assets without requiring Python. To rebuild from the verified upstream cache:

```sh
python3 -m venv packages/office-docx/test/output/font-tools
packages/office-docx/test/output/font-tools/bin/python -m pip install 'fonttools[woff]==4.60.1' 'brotli==1.1.0' 'zopfli==0.2.3.post1'
packages/office-docx/test/output/font-tools/bin/python packages/office-docx/prepare-print-fonts.py
```

Original OFL notices and license are preserved in LICENSE-OFL.txt and the output THIRD-PARTY-NOTICES. Native PDF extraction and visual acceptance are tracked in the Word implementation document; constructing these assets alone is not evidence of a native PDF fix.

External renderer builds copy these verified bytes to `dist/print-fonts/` and emit `dist/print-fonts.json`, mapping each hashed screen-font asset to its print derivative. `renderer-resources.json` includes all pairs. The external renderer fetches the mapping only during output and fetches only faces selected by the existing loaded-family/weight/unicode/character filter. Opening or previewing the editor does not decode or fetch print-only fonts. The self-contained legacy bundle retains its Blob mapping for compatibility.
