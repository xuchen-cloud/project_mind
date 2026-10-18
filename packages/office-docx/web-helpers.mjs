// Generated from Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4; see vendor-web/LICENSE and NOTICE.
function downloadBytes(data, name) {
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function hiddenInput(accept) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    return input;
}
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}
function pickViaInput(accept) {
    return new Promise((resolve) => {
        const input = hiddenInput(accept);
        input.onchange = () => {
            const file = input.files?.[0] ?? null;
            input.remove();
            resolve(file);
        };
        input.oncancel = () => {
            input.remove();
            resolve(null);
        };
        input.click();
    });
}
export { pickViaInput };
export const pickImage = async () => {
    const file = await pickViaInput('image/png,image/jpeg,image/gif');
    if (!file)
        return null;
    const mime = file.type;
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/gif')
        return null;
    return { base64: await fileToBase64(file), mime, name: file.name };
};
export const copyImageToClipboard = async (dataUrl) => {
    try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        return true;
    }
    catch {
        return false;
    }
};
export const exportHtml = async (defaultName, html) => {
    const name = defaultName.endsWith('.html') ? defaultName : `${defaultName}.html`;
    downloadBytes(new TextEncoder().encode(html).buffer, name);
    return { ok: true, path: name };
};
