var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import fsp from 'fs/promises';
import path from 'path';
import { parseMark, parseMarkHold, showMark } from './mark';
export function loadManifest(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const file = path.join(input.dir, 'deck.tree');
        const text = yield fsp.readFile(file, 'utf-8');
        return parseManifest({ text });
    });
}
export function parseManifest(input) {
    const lines = input.text.split('\n');
    let host = '';
    let name = '';
    let mark = { major: 0, minor: 0, patch: 0 };
    let head;
    const mind = [];
    let lock;
    const term = [];
    const link = [];
    const hook = {};
    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();
        i++;
        if (!line || line.startsWith('#'))
            continue;
        if (line.startsWith('deck ')) {
            const deckName = line.slice(5).trim();
            const parts = deckName.split('/');
            if (parts.length === 2 && parts[0].startsWith('@')) {
                host = parts[0].slice(1);
                name = parts[1];
            }
            else {
                name = deckName;
            }
            continue;
        }
        if (line.startsWith('mark ')) {
            const markText = extractAngle(line.slice(5).trim());
            mark = parseMark(markText);
            continue;
        }
        if (line.startsWith('head ')) {
            head = extractAngle(line.slice(5).trim());
            continue;
        }
        if (line.startsWith('mind ')) {
            mind.push({ name: extractAngle(line.slice(5).trim()) });
            continue;
        }
        if (line.startsWith('lock ')) {
            lock = line.slice(5).trim();
            continue;
        }
        if (line.startsWith('term ')) {
            term.push(extractAngle(line.slice(5).trim()));
            continue;
        }
        if (line.startsWith('link ')) {
            const linkLine = line.slice(5).trim();
            const parsed = parseLinkLine({ text: linkLine });
            if (parsed) {
                link.push(parsed);
            }
            continue;
        }
        if (line.startsWith('hook ')) {
            const hookParts = line.slice(5).trim().split(',');
            if (hookParts.length >= 2) {
                const hookName = hookParts[0].trim();
                const hookTask = hookParts
                    .slice(1)
                    .join(',')
                    .trim()
                    .replace(/^task\s+/, '');
                hook[hookName] = hookTask;
            }
            continue;
        }
    }
    return {
        host,
        name,
        mark,
        head,
        mind: mind.length > 0 ? mind : undefined,
        lock,
        term: term.length > 0 ? term : undefined,
        link,
        hook: Object.keys(hook).length > 0 ? hook : undefined,
    };
}
function parseLinkLine(input) {
    const parts = input.text.split(',').map(p => p.trim());
    const nameStr = parts[0];
    if (!nameStr)
        return undefined;
    let markHold = {
        form: 'wild',
        major: 0,
    };
    let have;
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i].trim();
        if (part.startsWith('mark ')) {
            const markText = extractAngle(part.slice(5).trim());
            markHold = parseMarkHold(markText);
        }
        if (part.startsWith('have ')) {
            have = parseInt(part.slice(5).trim(), 10);
        }
    }
    return {
        name: nameStr,
        mark: markHold,
        have,
    };
}
function extractAngle(text) {
    if (text.startsWith('<') && text.endsWith('>')) {
        return text.slice(1, -1);
    }
    return text;
}
export function writeManifest(input) {
    const lines = [];
    const m = input.manifest;
    const fullName = m.host ? `@${m.host}/${m.name}` : m.name;
    lines.push(`deck ${fullName}`);
    lines.push(`  mark <${showMark(m.mark)}>`);
    if (m.head) {
        lines.push(`  head <${m.head}>`);
    }
    if (m.mind) {
        for (const f of m.mind) {
            lines.push(`  mind <${f.name}>`);
        }
    }
    if (m.lock) {
        lines.push(`  lock ${m.lock}`);
    }
    if (m.term) {
        for (const t of m.term) {
            lines.push(`  term <${t}>`);
        }
    }
    for (const dep of m.link) {
        const markStr = writeMarkHold({ hold: dep.mark });
        let line = `  link ${dep.name}, mark <${markStr}>`;
        if (dep.have !== undefined) {
            line += `, have ${dep.have}`;
        }
        lines.push(line);
    }
    if (m.hook) {
        for (const [hookName, hookTask] of Object.entries(m.hook)) {
            lines.push(`  hook ${hookName}, task ${hookTask}`);
        }
    }
    return lines.join('\n') + '\n';
}
function writeMarkHold(input) {
    switch (input.hold.form) {
        case 'exact':
            return showMark(input.hold.mark);
        case 'wild': {
            const minor = input.hold.minor !== undefined ? `${input.hold.minor}` : 'x';
            const patch = input.hold.patch !== undefined ? `${input.hold.patch}` : 'x';
            return `${input.hold.major}.${minor}.${patch}`;
        }
        case 'band':
            return `${showMark(input.hold.base)}..${showMark(input.hold.head)}`;
        case 'test':
            return input.hold.list
                .map(w => writeMarkHold({ hold: w }))
                .join('|');
    }
}
//# sourceMappingURL=manifest.js.map