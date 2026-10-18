import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
HTMLElement.prototype.scrollIntoView = function () {};
// jsdom has no hit testing. Keep native drop dispatch inside the mounted rich
// editor; real coordinates and placement are checked in the browser round.
Document.prototype.elementFromPoint = function () { return this.querySelector('.tiptap'); };
// jsdom has no image decoder/layout engine; actual embedded assets and pagination
// geometry are verified by the browser and native PDF acceptance.
HTMLImageElement.prototype.decode = async function () {};
const frameDocument=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentDocument')!.get!;
Object.defineProperty(HTMLIFrameElement.prototype,'contentDocument',{configurable:true,get(){
  const doc=frameDocument.call(this) as Document|null;
  const view=doc?.defaultView as (Window & typeof globalThis)|null;
  if(view)view.HTMLImageElement.prototype.decode=async function(){};
  return doc;
}});
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };
afterEach(cleanup);
