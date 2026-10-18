import { toCanvas, toSvg } from 'html-to-image';
import type { BrowserDriver, ScreenshotOptions, Viewport, ClipRect } from '../upstream/packages/html2docx/src/driver';
import { CSP, MAX_BYTES, sanitizedDocument } from './sanitize';

const abortError = () => new DOMException('altChunk conversion aborted', 'AbortError');

/** Only upstream converter code can call evaluate/addScript; never exported as a host API. */
export class IframeDriver implements BrowserDriver {
  private readonly frame = document.createElement('iframe');
  private closed = false;
  private scale = 2;
  private screenshotBytes = 0;
  private timers = new Set<number>();
  public failure: unknown;
  public empty = false;
  constructor(private readonly html: string, private readonly signal?: AbortSignal) {
    this.frame.setAttribute('data-office-html2docx','');
    this.frame.setAttribute('aria-hidden','true');
    this.frame.setAttribute('sandbox','allow-same-origin');
    this.frame.tabIndex = -1;
    this.frame.style.cssText = 'position:fixed;left:-100000px;top:0;border:0;pointer-events:none;';
  }
  private realm(): Window & typeof globalThis {
    if (this.signal?.aborted) throw abortError();
    if (this.closed || !this.frame.contentWindow) throw new Error('altChunk iframe is closed');
    return this.frame.contentWindow as Window & typeof globalThis;
  }
  async setViewport(viewport: Viewport): Promise<void> {
    this.scale = viewport.deviceScaleFactor;
    this.frame.style.width = `${viewport.width}px`;
    this.frame.style.height = `${viewport.height}px`;
  }
  async goto(_url: string, {timeoutMs}: {timeoutMs: number}): Promise<void> {
    if (!this.frame.isConnected) {
      await new Promise<void>((resolve,reject) => {
        const cleanup = () => { clearTimeout(timer); this.frame.onload=null; this.signal?.removeEventListener('abort',cancel); };
        const cancel = () => {cleanup();reject(abortError());};
        const timer = setTimeout(()=>{cleanup();reject(new Error('altChunk iframe load timed out'));},timeoutMs);
        this.frame.onload = () => {cleanup();resolve();};
        this.signal?.addEventListener('abort',cancel,{once:true});
        this.frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body></body></html>`;
        document.body.append(this.frame);
        if (this.signal?.aborted) cancel();
      });
    }
    const realm = this.realm(), doc = realm.document;
    // Sandboxing disables page-scheduled callbacks, including trusted extractor
    // timers. Schedule only function callbacks on the host clock; input scripts
    // remain disabled. Track and cancel them with this driver's lifetime.
    realm.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') throw new Error('altChunk string timers are forbidden');
      const id = window.setTimeout(() => {this.timers.delete(id);if (!this.closed) callback(...args);},delay);
      this.timers.add(id);return id;
    }) as typeof window.setTimeout;
    realm.clearTimeout = ((id?: number) => {this.timers.delete(id!);window.clearTimeout(id);}) as typeof realm.clearTimeout;
    const sanitized = sanitizedDocument(this.html, realm), clean = sanitized.document;
    const preventNavigation = (event: Event) => event.preventDefault();
    for(const type of ['click','auxclick','submit'])doc.addEventListener(type,preventNavigation,true);
    for (const child of Array.from(doc.head.children)) if (!child.matches('meta[charset],meta[http-equiv="Content-Security-Policy"]')) child.remove();
    for (const attr of Array.from(doc.body.attributes)) doc.body.removeAttribute(attr.name);
    for (const attr of Array.from(clean.body.attributes)) doc.body.setAttribute(attr.name,attr.value);
    for (const attr of Array.from(doc.documentElement.attributes)) doc.documentElement.removeAttribute(attr.name);
    for (const attr of Array.from(clean.documentElement.attributes)) doc.documentElement.setAttribute(attr.name,attr.value);
    doc.title=clean.title;
    for (const style of Array.from(clean.head.querySelectorAll('style,meta[name]'))) doc.head.append(doc.adoptNode(style));
    doc.body.replaceChildren(...Array.from(clean.body.childNodes).map(node=>doc.adoptNode(node)));
    // WebKit also suppresses parent-installed DOM event listeners inside the
    // no-scripts sandbox. Route native link activation to a popup, which the
    // sandbox forbids, while retaining the real href for upstream extraction.
    for(const link of Array.from(doc.querySelectorAll('a[href]'))) {
      link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');link.removeAttribute('download');
    }
    const visual = sanitized.images.size>0 || Array.from(doc.body.querySelectorAll<HTMLElement>('*')).concat(doc.body,doc.documentElement).some(el=>{
      const css=realm.getComputedStyle(el);
      return css.backgroundImage!=='none'||!['rgba(0, 0, 0, 0)','transparent'].includes(css.backgroundColor)||['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'].some(side=>parseFloat(css[side as keyof CSSStyleDeclaration] as string)>0);
    });
    this.empty = !doc.body.innerText?.trim() && !visual && !doc.body.querySelector('img,hr,table,input,textarea,select');
    let decodedBytes=0;
    const images=await Promise.all(Array.from(sanitized.images).map(async source => {
      // WebKit suppresses image event callbacks in a no-scripts sandbox,
      // including callbacks assigned by the parent. Decode only the already
      // validated raster data URL in the host realm; no HTML enters it.
      const image = new Image();
      await new Promise<void>((resolve,reject)=>{
        image.onload=()=>resolve();image.onerror=()=>reject(new Error('altChunk image could not be loaded'));
        image.src=source;
      });
      this.pixelBudget(image.naturalWidth,image.naturalHeight,1);
      decodedBytes+=image.naturalWidth*image.naturalHeight*4;
      if(decodedBytes>MAX_BYTES)throw new Error('altChunk decoded images exceed 64 MiB pixel budget');
      return image;
    }));
    await Promise.all(images.map(async image=>{try{await image.decode();}catch{throw new Error('altChunk image could not be decoded');}}));
    for(const image of Array.from(doc.images)) {
      const box=image.getBoundingClientRect();
      if(box.width>0&&box.height>0)this.pixelBudget(box.width,box.height,this.scale);
    }
    this.realm();
  }
  async evaluate<T>(fn: string | ((arg?: any) => T | Promise<T>), arg?: unknown): Promise<T> {
    const realm = this.realm();
    // The only strings/functions reaching here are the locked converter and helpers.
    const source = typeof fn === 'string' ? `return (${fn})` : `return (${fn.toString()})(arg)`;
    return await realm.Function('arg',source)(arg);
  }
  async addScript(source: string): Promise<void> { this.realm().Function(source)(); }
  async addInitScript(): Promise<void> { throw new Error('altChunk debug scripts are not supported'); }
  async elementExists(selector: string): Promise<boolean> { return !!this.realm().document.querySelector(selector); }
  private pixelBudget(width: number,height: number,scale: number): void {
    if (![width,height,scale].every(Number.isFinite) || width<=0 || height<=0 || width*scale>16384 || height*scale>16384 || width*height*scale*scale*4>MAX_BYTES) throw new Error('altChunk screenshot exceeds 64 MiB pixel budget');
  }
  private async capture(node: HTMLElement, width: number,height: number,options: ScreenshotOptions, clip?: ClipRect): Promise<Uint8Array> {
    try {
      this.realm();this.pixelBudget(width,height,this.scale);
      let canvas: HTMLCanvasElement;
      if(clip){
        // Keep original document layout; crop the SVG viewport rather than
        // reflowing the whole page to the narrow clip's width.
        const realm=this.realm(),doc=realm.document;
        const uri=await toSvg(doc.documentElement,{width:doc.documentElement.scrollWidth,height:doc.documentElement.scrollHeight,skipFonts:true,fontEmbedCSS:''});
        const svg=new realm.DOMParser().parseFromString(decodeURIComponent(uri.slice(uri.indexOf(',')+1)),'image/svg+xml').documentElement;
        // html-to-image emits percentage dimensions. Freeze the original
        // layout viewport before narrowing the outer SVG to the crop.
        const foreign=svg.querySelector('foreignObject');
        if(!foreign)throw new Error('altChunk page renderer did not produce a foreignObject');
        foreign.setAttribute('width',svg.getAttribute('width')!);foreign.setAttribute('height',svg.getAttribute('height')!);
        // WebKit does not translate foreignObject HTML with SVG viewBox/x/y.
        // Move a fixed-size HTML wrapper instead, keeping authored layout.
        const wrapper=doc.createElementNS('http://www.w3.org/1999/xhtml','div');
        wrapper.style.cssText=`position:relative;width:${foreign.getAttribute('width')}px;height:${foreign.getAttribute('height')}px;left:${-clip.x}px;top:${-clip.y}px`;
        wrapper.append(...Array.from(foreign.childNodes));foreign.append(wrapper);
        svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));
        svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
        const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg));
        await image.decode();
        canvas=document.createElement('canvas');canvas.width=Math.ceil(width*this.scale);canvas.height=Math.ceil(height*this.scale);
        const context=canvas.getContext('2d');if(!context)throw new Error('altChunk canvas renderer is unavailable');
        if(!options.omitBackground){context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);}
        context.drawImage(image,0,0,canvas.width,canvas.height);
      }else{
        canvas=await toCanvas(node,{width,height,pixelRatio:this.scale,skipAutoScale:true,skipFonts:true,fontEmbedCSS:'',backgroundColor:options.omitBackground?undefined:'#ffffff'});
      }
      this.realm();
      const blob = await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('altChunk PNG encoding failed')),'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      this.screenshotBytes += bytes.length;
      if (!bytes.length || this.screenshotBytes>MAX_BYTES) throw new Error('altChunk screenshot exceeds 64 MiB byte budget');
      return bytes;
    } catch(error) {this.failure=error;throw error;}
  }
  async screenshot(options: ScreenshotOptions): Promise<Uint8Array> {
    const doc = this.realm().document;
    const clip = options.clip || {x:0,y:0,width:doc.documentElement.scrollWidth,height:doc.documentElement.scrollHeight};
    return this.capture(doc.body,clip.width,clip.height,options,clip);
  }
  async screenshotElement(selector: string,options: Pick<ScreenshotOptions,'omitBackground'>): Promise<Uint8Array | null> {
    const node = this.realm().document.querySelector<HTMLElement>(selector);
    if (!node) {this.failure=new Error('altChunk screenshot target is missing');throw this.failure;}
    const rect = node.getBoundingClientRect();
    if (rect.width<=0 || rect.height<=0) {this.failure=new Error('altChunk screenshot target has no area');throw this.failure;}
    return this.capture(node,rect.width,rect.height,options);
  }
  async close(): Promise<void> {this.closed=true;for(const id of this.timers)window.clearTimeout(id);this.timers.clear();this.frame.remove();}
}
