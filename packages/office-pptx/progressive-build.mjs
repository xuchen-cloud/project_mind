/** Local adaptations of the source-locked parser. Vendor bytes are never changed. */
export function progressiveEngineSource(source){
 const from='function parseSlideFromArchive(archive: PackageArchive, slidePath: string): Slide | null {';
 if(source.split(from).length!==2)throw Error('Pinned slide parser seam changed');
 return source.replace(from,'export '+from);
}

/** Unknown slide shells must retain their archive references during owned-resource liveness. */
export function progressiveResourceSource(source){
 const from='opened.deck.slides.map((deckSlide) => [deckSlide.path, currentSlideXml(deckSlide)])';
 if(source.split(from).length!==2)throw Error('Pinned resource liveness seam changed');
 return source.replace(from,'opened.deck.slides.filter((slide) => !(slide as Slide & {projectMindUnloaded?:boolean}).projectMindUnloaded).map((deckSlide) => [deckSlide.path, currentSlideXml(deckSlide)])');
}

/** Screenshots must resolve and decode their own page dependencies. */
export function progressiveSnapshotSource(source,kind){
 const from=kind==='zoom'
  ?`  const pngs = await renderSlidesToPngBase64(\n    tiles.map((tile) => slides[tile.target]!),\n    images,\n    1,\n  )`
  :`    pngs = await renderSlidesToPngBase64(\n      sel.map((i) => ctx.slides[i]!),\n      ctx.images,\n    )`;
 if(source.split(from).length!==2)throw Error(`Pinned ${kind} snapshot seam changed`);
 const to=kind==='zoom'
  ?`  const targets = tiles.map((tile) => slides[tile.target]!)\n  const pngs = await renderSlidesToPngBase64(targets, await prepareSlideImages(targets, images), 1)`
  :`    const targets = sel.map((i) => ctx.slides[i]!)\n    pngs = await renderSlidesToPngBase64(targets, await prepareSlideImages(targets, ctx.images))`;
 return source.replace(from,to);
}
