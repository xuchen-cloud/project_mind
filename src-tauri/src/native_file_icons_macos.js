// Fixed JXA source. Inputs are argv data, never executable source.
ObjC.import('AppKit');
function png(image) {
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
        null, 64, 64, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    if (!rep) throw new Error('Cannot allocate native icon bitmap');
    $.NSGraphicsContext.saveGraphicsState;
    try {
        $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
        image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositeSourceOver, 1);
    } finally {
        $.NSGraphicsContext.restoreGraphicsState;
    }
    const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    if (!data) throw new Error('Cannot encode native icon PNG');
    return 'data:image/png;base64,' + ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}
function run(argv) {
    const workspace = $.NSWorkspace.sharedWorkspace;
    if (argv[0] === 'type') {
        return JSON.stringify(png(workspace.iconForFileType($(argv[1]))));
    }
    if (argv[0] !== 'applications') throw new Error('Unknown native icon operation');
    const url = $.NSURL.fileURLWithPath($(argv[1]));
    const urls = workspace.URLsForApplicationsToOpenURL(url);
    const defaultURL = workspace.URLForApplicationToOpenURL(url);
    const defaultPath = defaultURL ? ObjC.unwrap(defaultURL.path) : null;
    if (urls.count > 64) throw new Error('Too many registered applications');
    const result = [];
    for (let i = 0; i < urls.count; i++) {
        const app = urls.objectAtIndex(i);
        const path = ObjC.unwrap(app.path);
        if (result.some(item => item.id === path)) continue;
        const name = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(app.path)).replace(/\.app$/i, '');
        result.push({ id: path, name: name, icon: png(workspace.iconForFile(app.path)), isDefault: path === defaultPath });
    }
    return JSON.stringify(result);
}
