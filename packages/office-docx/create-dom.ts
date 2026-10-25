import { DOMParser as LinkedomParser, Node } from 'linkedom';
// Upstream's AI HTML parser expects a browser document, whereas linkedom keeps
// fragments outside body. This lexical shim is injected only into the Node bundle.
export class DOMParser extends LinkedomParser {
  parseFromString(source: string, type: 'text/html') {
    return super.parseFromString(`<html><head></head><body>${source}</body></html>`, type);
  }
}
export { Node };
