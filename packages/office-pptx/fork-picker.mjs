// Generated from Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4; Apache-2.0.
export async function pickMediaFile(kind) {
    const accept = kind === 'video'
        ? { 'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.avi'] }
        : { 'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg'] };
    try {
        if (typeof window.showOpenFilePicker === 'function') {
            const handles = (await window.showOpenFilePicker({
                types: [{ description: kind, accept }],
                multiple: false,
            }));
            const file = await handles[0]?.getFile();
            if (!file)
                return null;
            return {
                bytes: new Uint8Array(await file.arrayBuffer()),
                ext: (file.name.split('.').pop() ?? (kind === 'video' ? 'mp4' : 'mp3')).toLowerCase(),
                name: file.name,
            };
        }
    }
    catch (e) {
        if (e.name === 'AbortError')
            return null;
    }
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = kind === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg';
        input.onchange = async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) {
                resolve(null);
                return;
            }
            resolve({
                bytes: new Uint8Array(await file.arrayBuffer()),
                ext: (file.name.split('.').pop() ?? (kind === 'video' ? 'mp4' : 'mp3')).toLowerCase(),
                name: file.name,
            });
        };
        input.oncancel = () => {
            input.remove();
            resolve(null);
        };
        input.click();
    });
}
export async function pickImageFile() {
    try {
        if (typeof window.showOpenFilePicker === 'function') {
            const handles = (await window.showOpenFilePicker({
                types: [
                    {
                        description: 'Images',
                        accept: {
                            'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'],
                        },
                    },
                ],
                multiple: false,
            }));
            const file = await handles[0]?.getFile();
            if (!file)
                return null;
            const bytes = new Uint8Array(await file.arrayBuffer());
            const ext = (file.name.split('.').pop() ?? 'png').toLowerCase();
            return { bytes, ext };
        }
    }
    catch (e) {
        if (e.name === 'AbortError')
            return null;
    }
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/tiff';
        input.onchange = async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) {
                resolve(null);
                return;
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            const ext = (file.name.split('.').pop() ?? 'png').toLowerCase();
            resolve({ bytes, ext });
        };
        input.oncancel = () => {
            input.remove();
            resolve(null);
        };
        input.click();
    });
}
export function imageNaturalSize(bytes) {
    return new Promise((resolve) => {
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            resolve({ width: img.naturalWidth || 4, height: img.naturalHeight || 3 });
            URL.revokeObjectURL(url);
        };
        img.onerror = () => {
            resolve({ width: 4, height: 3 });
            URL.revokeObjectURL(url);
        };
        img.src = url;
    });
}
