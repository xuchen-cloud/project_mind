// Generated from pinned slides/src/main/fonts.ts; Apache-2.0.
function norm(s) {
    return s
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s\-_]/g, '');
}
function readNameStrings(buf, nameOff) {
    const families = [];
    const subfamilies = [];
    const count = buf.readUInt16BE(nameOff + 2);
    const strBase = nameOff + buf.readUInt16BE(nameOff + 4);
    for (let i = 0; i < count; i++) {
        const r = nameOff + 6 + 12 * i;
        const platform = buf.readUInt16BE(r);
        const encoding = buf.readUInt16BE(r + 2);
        const nameId = buf.readUInt16BE(r + 6);
        if (nameId !== 1 && nameId !== 2 && nameId !== 16 && nameId !== 17)
            continue;
        const len = buf.readUInt16BE(r + 8);
        const off = strBase + buf.readUInt16BE(r + 10);
        if (off + len > buf.length)
            continue;
        let s;
        if (platform === 0 || platform === 3) {
            s = Buffer.from(buf.subarray(off, off + len))
                .swap16()
                .toString('utf16le');
        }
        else if (platform === 1 && encoding === 0) {
            s = buf.toString('latin1', off, off + len);
        }
        else {
            continue; // Mac-platform non-Roman encodings (legacy Korean/Chinese codepages) cannot be decoded; skip
        }
        if (!s)
            continue;
        const list = nameId === 1 || nameId === 16 ? families : subfamilies;
        if (!list.includes(s))
            list.push(s);
    }
    return { families, subfamilies };
}
export function readFaceDir(buf) {
    const offsets = buf.toString('ascii', 0, 4) === 'ttcf'
        ? Array.from({ length: buf.readUInt32BE(8) }, (_, i) => buf.readUInt32BE(12 + 4 * i))
        : [0];
    return offsets.map((offset) => {
        let families = [];
        let subfamilies = [];
        let weight;
        try {
            const numTables = buf.readUInt16BE(offset + 4);
            for (let t = 0; t < numTables; t++) {
                const e = offset + 12 + 16 * t;
                const tag = buf.toString('ascii', e, e + 4);
                if (tag === 'name') {
                    ;
                    ({ families, subfamilies } = readNameStrings(buf, buf.readUInt32BE(e + 8)));
                }
                else if (tag === 'OS/2') {
                    // usWeightClass: name records can be missing/undecodable (cloud numeric files),
                    // so face ranking needs the weight straight from the table
                    const w = buf.readUInt16BE(buf.readUInt32BE(e + 8) + 4);
                    if (w >= 1 && w <= 1000)
                        weight = w;
                }
            }
        }
        catch {
            /* Even if the name table is unreadable, the first face can still be parsed */
        }
        const ascii = families.find((f) => /^[\x20-\x7e]+$/.test(f));
        return {
            offset,
            display: ascii ?? families[0] ?? '',
            famKeys: families.map(norm),
            styleText: norm([...families, ...subfamilies].join(' ')),
            ...(weight != null ? { weight } : {}),
        };
    });
}
export function extractFace(buf, offset, drop) {
    const isTtc = buf.toString('ascii', 0, 4) === 'ttcf';
    if (!isTtc && !drop) {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    const faceOff = isTtc ? offset : 0;
    const numTables = buf.readUInt16BE(faceOff + 4);
    const entries = [];
    for (let t = 0; t < numTables; t++) {
        const e = faceOff + 12 + 16 * t;
        if (drop?.has(buf.toString('ascii', e, e + 4)))
            continue;
        entries.push({
            dirPos: e,
            tOff: buf.readUInt32BE(e + 8),
            tLen: buf.readUInt32BE(e + 12),
            newOff: 0,
        });
    }
    let total = 12 + 16 * entries.length;
    for (const e of entries) {
        e.newOff = total;
        total += (e.tLen + 3) & ~3;
    }
    const out = Buffer.alloc(total);
    buf.copy(out, 0, faceOff, faceOff + 4);
    out.writeUInt16BE(entries.length, 4);
    const pow = 2 ** Math.floor(Math.log2(entries.length || 1));
    out.writeUInt16BE(pow * 16, 6);
    out.writeUInt16BE(Math.log2(pow), 8);
    out.writeUInt16BE(entries.length * 16 - pow * 16, 10);
    for (let t = 0; t < entries.length; t++) {
        const e = entries[t];
        buf.copy(out, 12 + 16 * t, e.dirPos, e.dirPos + 8);
        out.writeUInt32BE(e.newOff, 12 + 16 * t + 8);
        out.writeUInt32BE(e.tLen, 12 + 16 * t + 12);
        buf.copy(out, e.newOff, e.tOff, e.tOff + e.tLen);
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
