import { DocxError } from './types';
import { imageSize } from './upstream/packages/cli/src/formats/image-size';
/** Only declared inline bytes cross the worker boundary; no path or network I/O. */
export async function readImageSource(source: string): Promise<{
    bytes: Uint8Array;
    ext: string;
    mime: string;
} | null> {
    const match = typeof source === 'string' && /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
    if (!match)
        throw new DocxError('INVALID_ARGUMENT', 'Office authoring images require an inline PNG, JPEG or GIF data URL');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2] || !bytes.length)
        throw new DocxError('INVALID_ARGUMENT', 'Invalid inline image encoding');
    const size = imageSize(bytes);
    if (!size || size.mime !== `image/${match[1]}`)
        throw new DocxError('INVALID_ARGUMENT', 'Inline image bytes do not match their declared format');
    return { bytes, mime: size.mime, ext: match[1] === 'jpeg' ? 'jpg' : match[1] };
}
