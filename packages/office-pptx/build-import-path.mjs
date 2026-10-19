import {join} from 'node:path';

// Module specifiers use slashes; JSON.stringify handles quotes in checkout paths.
export const buildImportPath = (...parts) => join(...parts.map(part=>part.replaceAll('\\','/'))).replaceAll('\\','/');
